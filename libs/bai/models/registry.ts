// Curated preset list. Each entry maps a short id to a HuggingFace
// repo + GGUF file. Update when a better small/medium model lands —
// keep the list short, opinionated, and CPU-friendly by default.

export type Preset = {
  readonly id: string
  readonly kind: "embed" | "llm"
  readonly repo: string
  readonly file: string
  readonly cacheName: string
  readonly dim?: number
  readonly sizeMb: number
  readonly notes: string
}

const PRESETS: readonly Preset[] = [
  // ── Embedding models ───────────────────────────────────────────────
  {
    id: "nomic-embed-text-v1.5",
    kind: "embed",
    repo: "nomic-ai/nomic-embed-text-v1.5-GGUF",
    file: "nomic-embed-text-v1.5.Q8_0.gguf",
    cacheName: "nomic-embed-text-v1.5.Q8_0.gguf",
    dim: 768,
    sizeMb: 274,
    notes: "MIT licensed, beats text-embedding-ada-002 on retrieval",
  },
  {
    id: "bge-small-en",
    kind: "embed",
    repo: "CompendiumLabs/bge-small-en-v1.5-gguf",
    file: "bge-small-en-v1.5-q8_0.gguf",
    cacheName: "bge-small-en-v1.5-q8_0.gguf",
    dim: 384,
    sizeMb: 130,
    notes: "Smallest viable English embedder — start here on tight RAM",
  },
  {
    id: "bge-m3",
    kind: "embed",
    repo: "lm-kit/bge-m3-gguf",
    file: "bge-m3-Q8_0.gguf",
    cacheName: "bge-m3-Q8_0.gguf",
    dim: 1024,
    sizeMb: 600,
    notes: "Multilingual; pick this if your corpus isn't English-only",
  },

  // ── Chat / generation models ───────────────────────────────────────
  {
    id: "llama3.2-3b",
    kind: "llm",
    repo: "bartowski/Llama-3.2-3B-Instruct-GGUF",
    file: "Llama-3.2-3B-Instruct-Q4_K_M.gguf",
    cacheName: "llama-3.2-3b-instruct-Q4_K_M.gguf",
    sizeMb: 2020,
    notes: "Smallest viable chat model — Q4 fits in ~2.5GB RAM",
  },
  {
    id: "qwen2.5-3b",
    kind: "llm",
    repo: "bartowski/Qwen2.5-3B-Instruct-GGUF",
    file: "Qwen2.5-3B-Instruct-Q4_K_M.gguf",
    cacheName: "qwen2.5-3b-instruct-Q4_K_M.gguf",
    sizeMb: 1900,
    notes: "Strong general-purpose 3B; better tool/JSON adherence than llama3.2",
  },
  {
    id: "phi3.5-mini",
    kind: "llm",
    repo: "bartowski/Phi-3.5-mini-instruct-GGUF",
    file: "Phi-3.5-mini-instruct-Q4_K_M.gguf",
    cacheName: "phi-3.5-mini-instruct-Q4_K_M.gguf",
    sizeMb: 2300,
    notes: "Microsoft small-model, 128k context",
  },
] as const

export const listPresets = (): readonly Preset[] => PRESETS

export const resolvePreset = (id: string): Preset | null =>
  PRESETS.find(p => p.id === id) ?? null
