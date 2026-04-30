# bai

In-process LLM inference via `bun:ffi` over llama.cpp. Drop-in alternative to `@atlas/ai`'s Ollama provider when you don't want a sidecar.

## Layout

```
index.ts                 — re-exports the public surface
ffi/index.ts             — bun:ffi bindings, one-time backend init
ffi/lib.ts               — locate libbai.{so,dylib,dll} on disk
embed/index.ts           — embed, embedBatch
generate/index.ts        — generate, generateStream (token callback bridged to async iterator)
similarity/index.ts      — cosineSim, dot
models/index.ts          — Model handle, loadModel/releaseModel
models/registry.ts       — curated GGUF presets (embed + chat)
util/cache.ts            — XDG-respecting cache dirs
util/download.ts         — resumable HF / release-artifact downloader
cli/index.ts             — `bai pull <preset>`, `bai list`
scripts/postinstall.ts   — fetches the platform native lib on bun install
native/rust/             — Rust shim → libbai.{so,dylib,dll}
native/build.sh          — host-only build helper
```

## FFI contract (stable)

```c
int  bai_init(void);
const char* bai_last_error(void);

void* bai_model_load(const char* path, int kind_hint);   // -1=auto, 0=embed, 1=llm
void  bai_model_free(void* h);
int   bai_model_dim(const void* h);
int   bai_model_kind(const void* h);                     // 0=embed, 1=llm

int   bai_embed(const void* h, const char* text, float* out);

typedef int (*bai_gen_cb)(const char* token, void* user);
int   bai_generate(const void* h, const char* prompt, int max_tokens, float temperature,
                   bai_gen_cb cb, void* user);
```

Stability rule: never change a signature here. Add new functions for new behaviour.

## Conventions

- Functional, no classes — Model is a plain readonly struct, all ops are free functions.
- Lowercase filenames, no separators (`-`/`_`/spaces). Modules at `<feature>/index.ts`.
- One concern per file. `embed/`, `generate/`, `similarity/`, `models/` stay independent.
- Errors from native code surface as thrown `Error` with the native `bai_last_error()` text appended.
- Pointers don't escape `ffi/` and `models/`. Public callers see opaque `Model` records.

## Adding a new model preset

1. Add a row to `PRESETS` in `models/registry.ts` with the HuggingFace repo, file, byte size, and dim (for embeddings).
2. Note the `cacheName` — keep it stable forever; it's the on-disk filename users may have already pulled.
3. Document in `README.md`'s preset table.

## Building the native lib

CPU-only on the host:

```sh
./native/build.sh
```

GPU variants (operators rebuild locally — release artifacts ship CPU-only):

```sh
BAI_FEATURE=metal  ./native/build.sh
BAI_FEATURE=cuda   ./native/build.sh
BAI_FEATURE=vulkan ./native/build.sh
```

Cross-compiles for all platforms belong in CI; not done here yet.

## Status

v0.0.1 draft. TypeScript surface, FFI bindings, Rust shim source all written. Release artifacts and integration tests pending.
