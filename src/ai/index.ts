import { type AnthropicConfig, createAnthropicDriver } from "./anthropic/index.ts"
import { createLocalDriver, type LocalConfig } from "./local/index.ts"
import { createOpenAiDriver, type OpenAiConfig } from "./openai/index.ts"

export type AiMessage = { role: "system" | "user" | "assistant"; content: string }

export type ChatOpts = {
  model?: string
  maxTokens?: number
  temperature?: number
}

export type ChatResult = { content: string; model: string }

export type AiDriver = {
  chat(messages: AiMessage[], opts?: ChatOpts): Promise<ChatResult>
}

export type AiHandle = AiDriver

export type AiConfig =
  | ({ driver: "openai" } & OpenAiConfig)
  | ({ driver: "anthropic" } & AnthropicConfig)
  | ({ driver: "local" } & LocalConfig)

export const createAi = (cfg: AiConfig): AiHandle => {
  if (cfg.driver === "openai") return createOpenAiDriver(cfg)
  if (cfg.driver === "anthropic") return createAnthropicDriver(cfg)
  if (cfg.driver === "local") return createLocalDriver(cfg)
  throw new Error(`Unknown AI driver: ${(cfg as { driver: string }).driver}`)
}

export const chat = (h: AiHandle, messages: AiMessage[], opts?: ChatOpts) => h.chat(messages, opts)
