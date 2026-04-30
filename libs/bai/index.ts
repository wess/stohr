// bai — in-process LLM inference via bun:ffi over llama.cpp.
// No sidecar, no HTTP. Model handles are opaque pointers; release them
// with `releaseModel(handle)` when you're done — there's no automatic GC
// across the FFI boundary.
//
// Functional API mirrors the shape of @atlas/ai (chat / chatStream /
// embed) so it can be substituted for any HTTP provider in that module
// by structural typing.

export { embed, embedBatch } from "./embed/index.ts"
export { generate, generateStream } from "./generate/index.ts"
export { cosineSim, dot } from "./similarity/index.ts"
export { loadModel, releaseModel, modelPath } from "./models/index.ts"
export { listPresets, resolvePreset } from "./models/registry.ts"
export { isAvailable } from "./ffi/index.ts"
export type { Model, ModelKind } from "./models/index.ts"
export type { GenerateOptions, GenerateChunk } from "./generate/index.ts"
export type { EmbedOptions } from "./embed/index.ts"
