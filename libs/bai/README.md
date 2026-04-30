# bai

In-process LLM inference for Bun, via `bun:ffi` over [llama.cpp](https://github.com/ggerganov/llama.cpp).

No sidecar, no HTTP. Models are loaded directly into the API process; embeddings and chat tokens come back through the FFI boundary.

## Why

`@atlas/ai` (sibling package) is the HTTP-provider abstraction — OpenAI, Anthropic, Ollama. `bai` is the in-process alternative: same conceptual surface, but the model runs in your process. One less daemon to deploy.

Rough cost trade against Ollama: you skip the inter-process JSON round-trip, you can't share the model across language runtimes, and you have to ship a native shared library per platform.

## Install

```sh
bun add bai
```

`bun install` runs `scripts/postinstall.ts` which fetches the prebuilt `libbai.{so,dylib,dll}` for your platform from GitHub releases. If you're on an unsupported platform or working on `bai` itself, build from source:

```sh
cd libs/bai/native && ./build.sh
```

This drops `libbai` under `native/dist/<platform>/` where the FFI loader looks for it.

## Usage

```ts
import { loadModel, releaseModel, embed, generate, cosineSim } from "bai"

// Embeddings
const e = loadModel("nomic-embed-text-v1.5")
const a = embed(e, "the quick brown fox")
const b = embed(e, "a fast brown vulpine")
console.log(cosineSim(a, b))            // > 0.85
releaseModel(e)

// Chat
const m = loadModel("llama3.2-3b")
for await (const chunk of generateStream(m, "Write a haiku about PostgreSQL.", { maxTokens: 60 })) {
  if (!chunk.done) process.stdout.write(chunk.text)
}
releaseModel(m)
```

Models are downloaded on demand:

```sh
bunx bai pull nomic-embed-text-v1.5
bunx bai pull llama3.2-3b
bunx bai list
```

GGUF files cache under `$BAI_CACHE_DIR` (default `~/.cache/bai/models`).

## Model presets

| id | kind | size | dim | notes |
| --- | --- | ---: | ---: | --- |
| `bge-small-en` | embed | 130 MB | 384 | Smallest viable English embedder |
| `nomic-embed-text-v1.5` | embed | 274 MB | 768 | MIT, beats `text-embedding-ada-002` |
| `bge-m3` | embed | 600 MB | 1024 | Multilingual |
| `llama3.2-3b` | llm | ~2 GB | — | Smallest viable chat |
| `qwen2.5-3b` | llm | ~1.9 GB | — | Better tool/JSON adherence |
| `phi3.5-mini` | llm | ~2.3 GB | — | 128k context |

You can also pass an absolute `.gguf` path to `loadModel` and skip the registry entirely.

## GPU acceleration

Default builds are CPU-only. To rebuild with GPU offload:

```sh
BAI_FEATURE=metal  ./libs/bai/native/build.sh    # macOS
BAI_FEATURE=cuda   ./libs/bai/native/build.sh    # Linux NVIDIA
BAI_FEATURE=vulkan ./libs/bai/native/build.sh    # cross-platform GPU
```

Prebuilt release artifacts are CPU-only — operators on GPU machines build locally and set `BAI_LIB` to the resulting `libbai.{so,dylib}`.

## API surface

```ts
loadModel(idOrPath, kindHint?): Model
releaseModel(model): void
modelPath(idOrPath): string

embed(model, text, opts?): Float32Array
embedBatch(model, texts, opts?): Float32Array[]

generate(model, prompt, opts?): Promise<string>
generateStream(model, prompt, opts?): AsyncGenerator<{ text, done }>

cosineSim(a, b): number
dot(a, b): number

listPresets(): readonly Preset[]
resolvePreset(id): Preset | null
```

## Status

**v0.1 — drafted, not yet built.** The TypeScript surface, FFI bindings, model registry, CLI, and Rust shim source are all here. What's missing:

- Release artifacts: GitHub Actions workflow that cross-compiles `libbai.{so,dylib,dll}` for linux/macos/windows × x64/arm64 and uploads them to a GitHub release.
- Test coverage: integration tests against real GGUF files (probably gated behind `BAI_TEST_MODEL=…`).
- Image embeddings (CLIP/SigLIP). The Rust shim is text-only for now.
- Worker-thread offload for long generations so streaming tokens don't block the JS event loop.

## License

Apache-2.0.
