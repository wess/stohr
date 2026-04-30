import { existsSync } from "node:fs"
import { join } from "node:path"
import { native, lastError, cstr, KIND_EMBED, KIND_LLM, type Pointer } from "../ffi/index.ts"
import { modelsCacheDir } from "../util/cache.ts"
import { resolvePreset } from "./registry.ts"

export type ModelKind = "embed" | "llm"

// Opaque handle. Don't reach inside this — the only thing that's stable
// across versions is the `ptr` field, and even that should only be
// passed back to bai functions.
export type Model = {
  readonly ptr: Pointer
  readonly path: string
  readonly kind: ModelKind
  readonly dim: number
  readonly preset: string | null
}

// Resolve a model identifier to an absolute GGUF path on disk.
//   - looks like a path? trust it (must exist)
//   - looks like a preset name? resolve via registry to the cached path
export const modelPath = (idOrPath: string): string => {
  if (idOrPath.includes("/") || idOrPath.endsWith(".gguf")) {
    if (!existsSync(idOrPath)) {
      throw new Error(`bai: model file not found at '${idOrPath}'`)
    }
    return idOrPath
  }
  const preset = resolvePreset(idOrPath)
  if (!preset) {
    throw new Error(`bai: unknown model preset '${idOrPath}'. See \`bai list\` or pass an absolute path.`)
  }
  const cached = join(modelsCacheDir(), preset.cacheName)
  if (!existsSync(cached)) {
    throw new Error(
      `bai: preset '${idOrPath}' not downloaded. Run \`bai pull ${idOrPath}\` first.`,
    )
  }
  return cached
}

// `kindHint` is a perf hint, not authoritative — the native side reads
// model metadata to decide if it's an embed-only or LLM file. Callers
// usually omit it.
export const loadModel = (idOrPath: string, kindHint?: ModelKind): Model => {
  const path = modelPath(idOrPath)
  const hint = kindHint === "llm" ? KIND_LLM : kindHint === "embed" ? KIND_EMBED : -1

  const handle = native.bai_model_load(cstr(path), hint)
  if (!handle) {
    throw new Error(`bai: failed to load model '${idOrPath}': ${lastError()}`)
  }

  const dim = native.bai_model_dim(handle)
  const detectedKind = native.bai_model_kind(handle) === KIND_EMBED ? "embed" : "llm"
  const preset = idOrPath.includes("/") || idOrPath.endsWith(".gguf") ? null : idOrPath
  return { ptr: handle, path, kind: detectedKind, dim, preset }
}

export const releaseModel = (model: Model): void => {
  native.bai_model_free(model.ptr)
}
