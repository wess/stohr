import { dlopen, FFIType, ptr, suffix, type Pointer } from "bun:ffi"
import { resolveLibPath } from "./lib.ts"

// Lazy `dlopen` of the native library. We do NOT open at import time so
// that programs which conditionally use bai (e.g. "embed only when
// AI_EMBED_MODEL is set") can `import "bai"` without crashing on hosts
// where libbai isn't installed yet. The first call into any FFI fn
// triggers the load — and surfaces a clear error if the lib is missing.

type Symbols = {
  bai_init: () => number
  bai_last_error: () => string | null
  bai_model_load: (path: Buffer, kindHint: number) => Pointer | null
  bai_model_free: (handle: Pointer) => void
  bai_model_dim: (handle: Pointer) => number
  bai_model_kind: (handle: Pointer) => number
  bai_embed: (handle: Pointer, text: Buffer, out: Pointer) => number
  bai_generate: (
    handle: Pointer,
    prompt: Buffer,
    maxTokens: number,
    temperature: number,
    cb: Pointer | null,
    user: Pointer | null,
  ) => number
}

let cached: Symbols | null = null

const open = (): Symbols => {
  if (cached) return cached
  const libPath = resolveLibPath(suffix)
  const { symbols } = dlopen(libPath, {
    bai_init: { args: [], returns: FFIType.i32 },
    bai_last_error: { args: [], returns: FFIType.cstring },
    bai_model_load: { args: [FFIType.cstring, FFIType.i32], returns: FFIType.ptr },
    bai_model_free: { args: [FFIType.ptr], returns: FFIType.void },
    bai_model_dim: { args: [FFIType.ptr], returns: FFIType.i32 },
    bai_model_kind: { args: [FFIType.ptr], returns: FFIType.i32 },
    bai_embed: { args: [FFIType.ptr, FFIType.cstring, FFIType.ptr], returns: FFIType.i32 },
    bai_generate: {
      args: [FFIType.ptr, FFIType.cstring, FFIType.i32, FFIType.f32, FFIType.function, FFIType.ptr],
      returns: FFIType.i32,
    },
  })
  // Backend init is idempotent on the native side; safe to call once
  // here on the first dlopen of the process.
  const initRc = (symbols as unknown as Symbols).bai_init()
  if (initRc !== 0) {
    const err = (symbols as unknown as Symbols).bai_last_error()
    throw new Error(`bai: init failed (rc=${initRc}): ${err ?? "unknown"}`)
  }
  cached = symbols as unknown as Symbols
  return cached
}

// Proxy that forwards property access to the lazy-loaded symbols. Lets
// callers write `native.bai_embed(...)` without thinking about open().
export const native = new Proxy({} as Symbols, {
  get(_target, prop: keyof Symbols) {
    const s = open()
    return s[prop]
  },
}) as Symbols

export type { Pointer }
export { ptr }

export const lastError = (): string => {
  try {
    const s = native.bai_last_error()
    return s ? String(s) : "unknown"
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

// Probe whether libbai can be loaded right now. Use this from hosts
// that want to enable AI features only when the native lib is available.
// Returns the same error string on failure.
export const isAvailable = (): { ok: true } | { ok: false; error: string } => {
  try {
    open()
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export const cstr = (s: string): Buffer => Buffer.from(s + "\0", "utf-8")

export const KIND_EMBED = 0
export const KIND_LLM = 1
