import { log } from "../log/index.ts"

// Stohr's AI integration — wraps `bai` (in-process llama.cpp via FFI)
// behind a small interface that the rest of the codebase imports. Built
// to be optional: if AI_EMBED_MODEL is unset, libbai is missing, or
// model load fails, every entry point here becomes a graceful no-op
// and the rest of the API keeps working with filename search only.

// Resolved at boot via initAi(); null until then.
type Ready = {
  readonly enabled: true
  readonly model: import("bai").Model
  readonly modelId: string
  readonly dim: number
  readonly bai: typeof import("bai")
}
type Disabled = { readonly enabled: false; readonly reason: string }
type State = Ready | Disabled

let state: State = { enabled: false, reason: "not initialized" }

export const initAi = async (modelId: string | undefined): Promise<void> => {
  if (!modelId) {
    state = { enabled: false, reason: "AI_EMBED_MODEL not set" }
    return
  }

  let bai: typeof import("bai")
  try {
    // Dynamic import keeps `bai`'s libbai dlopen out of cold-boot until
    // we know AI is wanted.
    bai = await import("bai")
  } catch (err) {
    state = {
      enabled: false,
      reason: `bai import failed: ${err instanceof Error ? err.message : String(err)}`,
    }
    log.warn("ai disabled", { reason: state.reason })
    return
  }

  const probe = bai.isAvailable()
  if (!probe.ok) {
    state = { enabled: false, reason: probe.error }
    log.warn("ai disabled — libbai not available", { error: probe.error })
    return
  }

  try {
    const model = bai.loadModel(modelId, "embed")
    if (model.dim !== 768) {
      // The pgvector column is locked at vector(768). Refuse to enable
      // semantic search with a different dim rather than insert rows
      // that will silently be wrong.
      bai.releaseModel(model)
      state = {
        enabled: false,
        reason: `model '${modelId}' has dim=${model.dim}; v1 requires dim=768. Use nomic-embed-text-v1.5.`,
      }
      log.warn("ai disabled — incompatible embedding dim", { model_id: modelId, dim: model.dim })
      return
    }
    state = { enabled: true, model, modelId, dim: model.dim, bai }
    log.info("ai enabled", { model: modelId, dim: model.dim, kind: model.kind })
  } catch (err) {
    state = {
      enabled: false,
      reason: `loadModel failed: ${err instanceof Error ? err.message : String(err)}`,
    }
    log.warn("ai disabled — model load failed", { reason: state.reason })
  }
}

export const isAiEnabled = (): boolean => state.enabled

export const aiStatus = (): { enabled: boolean; model: string | null; dim: number | null; reason: string | null } => {
  if (state.enabled) return { enabled: true, model: state.modelId, dim: state.dim, reason: null }
  return { enabled: false, model: null, dim: null, reason: state.reason }
}

// Returns null when AI is disabled. Callers should silently fall back
// to whatever the non-AI code path does — never throw on disabled.
export const embedText = (text: string): Float32Array | null => {
  if (!state.enabled) return null
  try {
    return state.bai.embed(state.model, text)
  } catch (err) {
    log.error("embed failed", { err: err instanceof Error ? err.message : String(err) })
    return null
  }
}

export const aiModelId = (): string | null => (state.enabled ? state.modelId : null)

export const closeAi = (): void => {
  if (state.enabled) {
    try { state.bai.releaseModel(state.model) } catch { /* best-effort */ }
    state = { enabled: false, reason: "shutdown" }
  }
}
