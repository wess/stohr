import type { AiDriver, AiMessage, ChatOpts, ChatResult } from "../index.ts"

export type AnthropicConfig = {
  apiKey: string
  baseUrl?: string
  model?: string
}

type AnthropicResponse = {
  model: string
  content: Array<{ type: string; text?: string }>
}

export const createAnthropicDriver = (cfg: AnthropicConfig): AiDriver => {
  const base = (cfg.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "")
  const defaultModel = cfg.model ?? "claude-haiku-4-5-20251001"

  return {
    chat: async (messages: AiMessage[], opts?: ChatOpts): Promise<ChatResult> => {
      // Anthropic separates system from the conversation turns.
      const system =
        messages
          .filter(m => m.role === "system")
          .map(m => m.content)
          .join("\n\n") || undefined
      const turns = messages.filter(m => m.role !== "system").map(m => ({ role: m.role, content: m.content }))

      const res = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": cfg.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: opts?.model ?? defaultModel,
          system,
          messages: turns,
          max_tokens: opts?.maxTokens ?? 1024,
          temperature: opts?.temperature,
        }),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => "")
        throw new Error(`Anthropic chat failed (${res.status}): ${text.slice(0, 500)}`)
      }
      const data = (await res.json()) as AnthropicResponse
      const content = data.content
        .filter(b => b.type === "text")
        .map(b => b.text ?? "")
        .join("")
      return { content, model: data.model }
    },
  }
}
