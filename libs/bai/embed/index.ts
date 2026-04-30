import { native, lastError, cstr, ptr } from "../ffi/index.ts"
import type { Model } from "../models/index.ts"

export type EmbedOptions = {
  // Optional name for diagnostics. Doesn't affect the math.
  readonly source?: string
}

// One pass of tokens → one pooled embedding vector. The Float32Array is
// freshly allocated; the caller owns it. Throws on tokenization or
// inference error — there is no partial-success state.
export const embed = (model: Model, text: string, _opts: EmbedOptions = {}): Float32Array => {
  if (model.kind !== "embed") {
    throw new Error(`bai: model '${model.preset ?? model.path}' is a chat model — use generate() instead`)
  }
  const out = new Float32Array(model.dim)
  const rc = native.bai_embed(model.ptr, cstr(text), ptr(out))
  if (rc !== 0) {
    throw new Error(`bai: embed failed (rc=${rc}): ${lastError()}`)
  }
  return out
}

// Sequential batch — llama.cpp processes one sequence at a time anyway,
// and exposing a batch API up front gives us room to add real
// llama_batch parallelism later without breaking callers.
export const embedBatch = (model: Model, texts: readonly string[], opts: EmbedOptions = {}): Float32Array[] => {
  const out: Float32Array[] = []
  for (const t of texts) out.push(embed(model, t, opts))
  return out
}
