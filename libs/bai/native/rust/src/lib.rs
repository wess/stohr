// bai native shim: a minimal C ABI over llama-cpp-2.
//
// Stability rule: never change a function signature here. New
// functionality goes in new functions; deprecated ones live forever.
// This is the boundary that JS and Rust agree on.
//
// Threading: the llama backend is initialized once via `bai_init`. All
// other entry points are thread-safe at the model/context level — call
// from one OS thread per Model handle. JS uses one event-loop thread,
// so this is fine in practice.

use std::ffi::{c_char, c_float, c_int, c_void, CStr, CString};
use std::path::PathBuf;
use std::ptr;
use std::sync::Mutex;

use llama_cpp_2::context::params::LlamaContextParams;
use llama_cpp_2::context::LlamaContext;
use llama_cpp_2::llama_backend::LlamaBackend;
use llama_cpp_2::llama_batch::LlamaBatch;
use llama_cpp_2::model::params::LlamaModelParams;
use llama_cpp_2::model::{AddBos, LlamaModel};
use llama_cpp_2::sampling::LlamaSampler;

use once_cell::sync::OnceCell;

const KIND_EMBED: c_int = 0;
const KIND_LLM: c_int = 1;

static BACKEND: OnceCell<LlamaBackend> = OnceCell::new();

thread_local! {
    static LAST_ERROR: std::cell::RefCell<CString> = std::cell::RefCell::new(CString::new("").unwrap());
}

fn set_error(msg: impl Into<String>) {
    let s = msg.into();
    let c = CString::new(s).unwrap_or_else(|_| CString::new("error").unwrap());
    LAST_ERROR.with(|cell| *cell.borrow_mut() = c);
}

fn ok<T, E: std::fmt::Display>(r: Result<T, E>) -> Option<T> {
    match r {
        Ok(v) => Some(v),
        Err(e) => {
            set_error(format!("{}", e));
            None
        }
    }
}

#[no_mangle]
pub extern "C" fn bai_init() -> c_int {
    if BACKEND.get().is_some() {
        return 0;
    }
    match LlamaBackend::init() {
        Ok(b) => {
            let _ = BACKEND.set(b);
            0
        }
        Err(e) => {
            set_error(format!("backend init: {}", e));
            -1
        }
    }
}

#[no_mangle]
pub extern "C" fn bai_last_error() -> *const c_char {
    LAST_ERROR.with(|cell| cell.borrow().as_ptr())
}

// Opaque handle returned to JS. Wraps the model and a single inference
// context so callers don't have to thread two pointers through.
struct Handle {
    // Model is heap-allocated and outlives the context (which borrows
    // it). We hold a raw pointer to the leaked Box and free it when
    // the handle is dropped.
    model: *mut LlamaModel,
    ctx: Mutex<LlamaContext<'static>>,
    kind: c_int,
    dim: c_int,
}

unsafe impl Send for Handle {}
unsafe impl Sync for Handle {}

impl Drop for Handle {
    fn drop(&mut self) {
        // Drop context first (borrows model), then drop the model box.
        // We can't access self.ctx directly because dropping the Mutex
        // already runs the LlamaContext drop, so by the time we get
        // here the context is gone — safe to free the model.
        if !self.model.is_null() {
            // SAFETY: pointer was minted by Box::leak in `bai_model_load`.
            unsafe { drop(Box::from_raw(self.model)) }
        }
    }
}

#[no_mangle]
pub extern "C" fn bai_model_load(path: *const c_char, kind_hint: c_int) -> *mut c_void {
    let backend = match BACKEND.get() {
        Some(b) => b,
        None => {
            set_error("bai_init() must be called before bai_model_load()");
            return ptr::null_mut();
        }
    };

    let path_str = unsafe {
        if path.is_null() {
            set_error("model path is null");
            return ptr::null_mut();
        }
        match CStr::from_ptr(path).to_str() {
            Ok(s) => s,
            Err(_) => {
                set_error("model path is not valid utf-8");
                return ptr::null_mut();
            }
        }
    };

    let model_params = LlamaModelParams::default();
    let model = match ok(LlamaModel::load_from_file(backend, PathBuf::from(path_str), &model_params)) {
        Some(m) => m,
        None => return ptr::null_mut(),
    };

    // Embed vs LLM: rely on the caller's hint. The Rust binding doesn't
    // expose a clean "is this an embedding-only model?" predicate, so
    // the JS side passes the hint explicitly via loadModel(id, "embed").
    // When unspecified, default to LLM — embedding models will fail
    // loudly at embed() time if mis-tagged.
    let kind = if kind_hint == KIND_EMBED || kind_hint == KIND_LLM {
        kind_hint
    } else {
        KIND_LLM
    };

    let mut ctx_params = LlamaContextParams::default();
    if kind == KIND_EMBED {
        ctx_params = ctx_params.with_embeddings(true);
    }

    // Heap-allocate the model and grab a raw pointer up front. All
    // subsequent uses of the model go through the raw pointer (or a
    // 'static reference dereferenced from it), avoiding the borrow
    // checker conflict between "the context borrows the model" and
    // "the Handle stores the model pointer".
    let model_ptr: *mut LlamaModel = Box::into_raw(Box::new(model));
    // SAFETY: model_ptr is valid for the lifetime of the Handle (we
    // free it only in Handle::drop, after the context is dropped).
    let model_ref: &'static LlamaModel = unsafe { &*model_ptr };

    let ctx = match ok(model_ref.new_context(backend, ctx_params)) {
        Some(c) => c,
        None => {
            // SAFETY: model_ref is the only outstanding borrow and we
            // are dropping it at end-of-scope; the raw pointer is ours
            // to free.
            unsafe { drop(Box::from_raw(model_ptr)); }
            return ptr::null_mut();
        }
    };

    let dim = model_ref.n_embd();

    let handle = Box::new(Handle {
        model: model_ptr,
        ctx: Mutex::new(ctx),
        kind,
        dim: dim as c_int,
    });

    Box::into_raw(handle) as *mut c_void
}

#[no_mangle]
pub extern "C" fn bai_model_free(handle: *mut c_void) {
    if handle.is_null() {
        return;
    }
    // SAFETY: handle was minted by `bai_model_load`. Drop runs in the
    // order context -> model.
    unsafe {
        let _ = Box::from_raw(handle as *mut Handle);
    }
}

#[no_mangle]
pub extern "C" fn bai_model_dim(handle: *const c_void) -> c_int {
    if handle.is_null() {
        return -1;
    }
    let h = unsafe { &*(handle as *const Handle) };
    h.dim
}

#[no_mangle]
pub extern "C" fn bai_model_kind(handle: *const c_void) -> c_int {
    if handle.is_null() {
        return -1;
    }
    let h = unsafe { &*(handle as *const Handle) };
    h.kind
}

#[no_mangle]
pub extern "C" fn bai_embed(
    handle: *const c_void,
    text: *const c_char,
    out: *mut c_float,
) -> c_int {
    if handle.is_null() || text.is_null() || out.is_null() {
        set_error("bai_embed: null argument");
        return -1;
    }
    let h = unsafe { &*(handle as *const Handle) };
    if h.kind != KIND_EMBED {
        set_error("bai_embed: model is not an embedding model");
        return -2;
    }

    let s = unsafe {
        match CStr::from_ptr(text).to_str() {
            Ok(s) => s,
            Err(_) => { set_error("bai_embed: text is not valid utf-8"); return -3; }
        }
    };

    // SAFETY: handle owns the model box; while the handle lives, this
    // reference is valid. The C ABI requires an unsafe lift-back.
    let model: &LlamaModel = unsafe { &*h.model };

    let tokens = match ok(model.str_to_token(s, AddBos::Always)) {
        Some(t) => t,
        None => return -4,
    };

    let mut ctx = h.ctx.lock().unwrap();
    let n_ctx = ctx.n_ctx() as usize;
    if tokens.len() > n_ctx {
        set_error(format!("bai_embed: input has {} tokens, exceeds n_ctx={}", tokens.len(), n_ctx));
        return -5;
    }

    let mut batch = LlamaBatch::new(tokens.len(), 1);
    let last = tokens.len() - 1;
    for (i, tok) in tokens.iter().enumerate() {
        if let Err(e) = batch.add(*tok, i as i32, &[0], i == last) {
            set_error(format!("batch add: {}", e));
            return -6;
        }
    }

    ctx.clear_kv_cache();
    if let Err(e) = ctx.decode(&mut batch) {
        set_error(format!("decode: {}", e));
        return -7;
    }

    let emb = match ctx.embeddings_seq_ith(0) {
        Ok(e) => e,
        Err(e) => { set_error(format!("embeddings: {}", e)); return -8; }
    };
    let dim = h.dim as usize;
    if emb.len() != dim {
        set_error(format!("embedding dim mismatch: got {}, expected {}", emb.len(), dim));
        return -9;
    }

    // L2-normalize so cosine similarity in JS is a plain dot product
    // and search results don't have to renormalize per-row.
    let norm = emb.iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-12);
    unsafe {
        let slice = std::slice::from_raw_parts_mut(out, dim);
        for (i, v) in emb.iter().enumerate() {
            slice[i] = v / norm;
        }
    }
    0
}

// Generate callback signature: fn(text: *const c_char, user: *mut c_void) -> c_int
// Returns 0 to continue, non-zero to abort.
type GenCb = extern "C" fn(*const c_char, *mut c_void) -> c_int;

#[no_mangle]
pub extern "C" fn bai_generate(
    handle: *const c_void,
    prompt: *const c_char,
    max_tokens: c_int,
    temperature: c_float,
    cb: GenCb,
    user: *mut c_void,
) -> c_int {
    if handle.is_null() || prompt.is_null() {
        set_error("bai_generate: null argument");
        return -1;
    }
    let h = unsafe { &*(handle as *const Handle) };
    if h.kind != KIND_LLM {
        set_error("bai_generate: model is not a chat model");
        return -2;
    }

    let s = unsafe {
        match CStr::from_ptr(prompt).to_str() {
            Ok(s) => s,
            Err(_) => { set_error("bai_generate: prompt is not valid utf-8"); return -3; }
        }
    };

    let model: &LlamaModel = unsafe { &*h.model };

    let tokens = match ok(model.str_to_token(s, AddBos::Always)) {
        Some(t) => t,
        None => return -4,
    };

    let mut ctx = h.ctx.lock().unwrap();
    ctx.clear_kv_cache();

    let n_ctx = ctx.n_ctx() as usize;
    let mut batch = LlamaBatch::new(n_ctx, 1);
    let last = tokens.len() - 1;
    for (i, tok) in tokens.iter().enumerate() {
        if let Err(e) = batch.add(*tok, i as i32, &[0], i == last) {
            set_error(format!("batch add: {}", e));
            return -5;
        }
    }
    if let Err(e) = ctx.decode(&mut batch) {
        set_error(format!("decode: {}", e));
        return -6;
    }

    // Sampler: greedy (temperature <= 0) or temp-then-dist chain. The
    // dist seed is fixed for now — production will want it configurable.
    let mut sampler = if temperature <= 0.0 {
        LlamaSampler::greedy()
    } else {
        LlamaSampler::chain_simple([
            LlamaSampler::temp(temperature),
            LlamaSampler::dist(0xC0FFEE),
        ])
    };

    let mut n_cur = batch.n_tokens();
    let max = max_tokens.max(1);

    for _ in 0..max {
        let next = sampler.sample(&ctx, batch.n_tokens() - 1);
        if model.is_eog_token(next) { break; }

        let bytes = match model.token_to_piece_bytes(next, 64, true, None) {
            Ok(b) => b,
            Err(_) => break,
        };
        // Strip embedded NULs — `CString::new` would reject them and
        // they'd corrupt the C-string boundary on the JS side anyway.
        let cleaned: Vec<u8> = bytes.into_iter().filter(|&b| b != 0).collect();
        let c = match CString::new(cleaned) {
            Ok(c) => c,
            Err(_) => break,
        };
        if cb(c.as_ptr(), user) != 0 { break; }

        sampler.accept(next);

        batch.clear();
        if let Err(e) = batch.add(next, n_cur, &[0], true) {
            set_error(format!("batch add (decode loop): {}", e));
            return -7;
        }
        if let Err(e) = ctx.decode(&mut batch) {
            set_error(format!("decode (loop): {}", e));
            return -8;
        }
        n_cur += 1;
    }
    0
}
