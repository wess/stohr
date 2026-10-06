import { responseJson } from "../../util/response/index.ts"
import type { AiDriver, AiMessage, ChatOpts, ChatResult } from "../index.ts"

export type OpenAiConfig = {
  apiKey: string
  baseUrl?: string
  model?: string
}

type OpenAiResponse = {
  model: string
  choices: Array<{ message: { content: string | null } }>
}

export const createOpenAiDriver = (cfg: OpenAiConfig): AiDriver => {
  const base = (cfg.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "")
  const defaultModel = cfg.model ?? "gpt-4o-mini"

  return {
    chat: async (messages: AiMessage[], opts?: ChatOpts): Promise<ChatResult> => {
      const res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({
          model: opts?.model ?? defaultModel,
          messages,
          max_tokens: opts?.maxTokens,
          temperature: opts?.temperature,
        }),
      })
      if (!res.ok) {
        await res.body?.cancel().catch(() => {})
        throw new Error(`OpenAI chat failed (${res.status})`)
      }
      const data = (await responseJson(res)) as OpenAiResponse
      return { content: data.choices[0]?.message?.content ?? "", model: data.model }
    },
  }
}
