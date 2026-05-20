import type { AiDriver } from "../index.ts"
import { createOpenAiDriver } from "../openai/index.ts"

export type LocalConfig = {
  baseUrl?: string
  apiKey?: string
  model?: string
}

// Local providers (Ollama, LM Studio, llama.cpp server, vLLM, etc.) all expose
// an OpenAI-compatible /chat/completions endpoint, so we just point the
// OpenAI driver at the local base URL. Default targets Ollama on :11434.
export const createLocalDriver = (cfg: LocalConfig): AiDriver =>
  createOpenAiDriver({
    apiKey: cfg.apiKey ?? "local",
    baseUrl: cfg.baseUrl ?? "http://localhost:11434/v1",
    model: cfg.model ?? "llama3.2",
  })
