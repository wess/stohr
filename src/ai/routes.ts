import type { Connection } from "@atlas/db"
import { from, raw } from "@atlas/db"
import { get, json, parseJson, pipeline, post, put } from "@atlas/server"
import { requireAuth } from "../auth/guard.ts"
import { ownerOnly } from "../security/owner.ts"
import { type AiHandle, type AiMessage, createAi } from "./index.ts"

const authId = (c: any) => (c.assigns.auth as { id: number }).id

type AiSettingsRow = {
  id: number
  provider: "openai" | "anthropic" | "local"
  api_key: string | null
  base_url: string | null
  chat_model: string | null
  enabled: boolean
  updated_by: number | null
  updated_at: string
  created_at: string
}

const loadRow = async (db: Connection): Promise<AiSettingsRow | null> => {
  const row = await db.one(from("ai_settings").orderBy("id", "ASC").limit(1))
  return (row ?? null) as AiSettingsRow | null
}

const buildHandle = (row: AiSettingsRow): AiHandle | null => {
  if (!row.enabled) return null
  const baseUrl = row.base_url ?? undefined
  const model = row.chat_model ?? undefined
  if (row.provider === "local") {
    return createAi({ driver: "local", baseUrl, apiKey: row.api_key ?? undefined, model })
  }
  // Hosted providers require an API key.
  if (!row.api_key) return null
  if (row.provider === "openai") {
    return createAi({ driver: "openai", apiKey: row.api_key, baseUrl, model })
  }
  if (row.provider === "anthropic") {
    return createAi({ driver: "anthropic", apiKey: row.api_key, baseUrl, model })
  }
  return null
}

// Loads settings + builds a handle on every call. Driver creation is just a
// fetch wrapper, so this is cheap; doing it per-request means PUT /ai/settings
// takes effect immediately without a process restart or cache invalidation.
export const loadAi = async (db: Connection): Promise<AiHandle | null> => {
  const row = await loadRow(db)
  if (!row) return null
  return buildHandle(row)
}

const redact = (row: AiSettingsRow) => ({
  provider: row.provider,
  base_url: row.base_url,
  chat_model: row.chat_model,
  enabled: row.enabled,
  has_api_key: !!row.api_key,
  updated_by: row.updated_by,
  updated_at: row.updated_at,
})

const VALID_PROVIDERS = new Set(["openai", "anthropic", "local"])

export const aiRoutes = (db: Connection, secret: string) => {
  const ownerCheck = ownerOnly(db)
  const guard = pipeline(requireAuth({ secret, db, noOAuth: true }), ownerCheck)
  const authed = pipeline(requireAuth({ secret, db, noOAuth: true }), ownerCheck, parseJson)

  return [
    get("/ai/settings", guard(async (c) => {
      const row = await loadRow(db)
      if (!row) return json(c, 404, { error: "AI settings row missing" })
      return json(c, 200, redact(row))
    })),

    put("/ai/settings", authed(async (c) => {
      const userId = authId(c)
      const body = c.body as {
        provider?: string
        api_key?: string | null
        apiKey?: string | null
        base_url?: string | null
        baseUrl?: string | null
        chat_model?: string | null
        chatModel?: string | null
        enabled?: boolean
      }

      const row = await loadRow(db)
      if (!row) return json(c, 404, { error: "AI settings row missing" })

      const update: Record<string, unknown> = { updated_by: userId, updated_at: raw("NOW()") }

      if (body.provider !== undefined) {
        if (!VALID_PROVIDERS.has(body.provider)) {
          return json(c, 422, { error: `provider must be one of: openai, anthropic, local` })
        }
        update.provider = body.provider
      }

      const apiKey = body.api_key !== undefined ? body.api_key : body.apiKey
      // undefined = leave alone; null = clear; string = set.
      if (apiKey !== undefined) update.api_key = apiKey

      const baseUrl = body.base_url !== undefined ? body.base_url : body.baseUrl
      if (baseUrl !== undefined) update.base_url = baseUrl

      const chatModel = body.chat_model !== undefined ? body.chat_model : body.chatModel
      if (chatModel !== undefined) update.chat_model = chatModel

      if (body.enabled !== undefined) update.enabled = body.enabled

      await db.execute(
        from("ai_settings").where(q => q("id").equals(row.id)).update(update),
      )

      const fresh = await loadRow(db)
      return json(c, 200, fresh ? redact(fresh) : null)
    })),

    post("/ai/chat", authed(async (c) => {
      const body = c.body as {
        messages?: AiMessage[]
        model?: string
        max_tokens?: number
        maxTokens?: number
        temperature?: number
      }
      if (!Array.isArray(body.messages) || body.messages.length === 0) {
        return json(c, 422, { error: "messages: non-empty array required" })
      }

      const handle = await loadAi(db)
      if (!handle) {
        return json(c, 503, { error: "AI is not enabled or not configured. Update /ai/settings first." })
      }

      try {
        const result = await handle.chat(body.messages, {
          model: body.model,
          maxTokens: body.max_tokens ?? body.maxTokens,
          temperature: body.temperature,
        })
        return json(c, 200, result)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return json(c, 502, { error: message })
      }
    })),
  ]
}
