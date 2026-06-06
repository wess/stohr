import type { Connection } from "@atlas/db"
import { from, raw } from "@atlas/db"
import { del, get, json, parseJson, patch, pipeline, post } from "@atlas/server"
import { requireAuth } from "../auth/guard.ts"
import { ownerOnly } from "../security/owner.ts"
import { type RemoteServer, remoteInitialize, remoteListTools } from "./client.ts"

const authId = (c: any) => (c.assigns.auth as { id: number }).id

type ServerRow = {
  id: number
  name: string
  description: string | null
  url: string
  auth_token: string | null
  enabled: boolean
  created_by: number | null
  created_at: string
  updated_at: string
}

const redact = (row: ServerRow) => ({
  id: row.id,
  name: row.name,
  description: row.description,
  url: row.url,
  has_auth_token: !!row.auth_token,
  enabled: row.enabled,
  created_by: row.created_by,
  created_at: row.created_at,
  updated_at: row.updated_at,
})

// Load every enabled outbound server. Used by AI integrations to assemble a
// merged tool catalog without exposing tokens.
export const loadEnabledServers = async (db: Connection): Promise<RemoteServer[]> => {
  const rows = (await db.all(
    from("mcp_servers")
      .where(q => q("enabled").equals(true))
      .select("url", "auth_token"),
  )) as Array<{ url: string; auth_token: string | null }>
  return rows.map(r => ({ url: r.url, authToken: r.auth_token }))
}

const isHttpUrl = (s: string): boolean => {
  try {
    const u = new URL(s)
    return u.protocol === "https:" || u.protocol === "http:"
  } catch {
    return false
  }
}

export const mcpServerRoutes = (db: Connection, secret: string) => {
  const ownerCheck = ownerOnly(db)
  const guard = pipeline(requireAuth({ secret, db, noOAuth: true }), ownerCheck)
  const authed = pipeline(requireAuth({ secret, db, noOAuth: true }), ownerCheck, parseJson)

  return [
    get(
      "/admin/mcp/servers",
      guard(async c => {
        const rows = (await db.all(from("mcp_servers").orderBy("created_at", "DESC"))) as ServerRow[]
        return json(c, 200, rows.map(redact))
      }),
    ),

    post(
      "/admin/mcp/servers",
      authed(async c => {
        const userId = authId(c)
        const body = c.body as {
          name?: string
          description?: string
          url?: string
          auth_token?: string
          authToken?: string
          enabled?: boolean
        }
        const name = typeof body.name === "string" ? body.name.trim() : ""
        const url = typeof body.url === "string" ? body.url.trim() : ""
        if (!name) return json(c, 422, { error: "name is required" })
        if (!url || !isHttpUrl(url)) return json(c, 422, { error: "url must be a valid http(s) URL" })
        const token = body.auth_token ?? body.authToken
        const authToken = typeof token === "string" && token.trim() ? token.trim() : null
        const description = typeof body.description === "string" ? body.description : null
        const enabled = body.enabled !== false

        const rows = (await db.execute(
          from("mcp_servers")
            .insert({
              name,
              description,
              url,
              auth_token: authToken,
              enabled,
              created_by: userId,
            })
            .returning(
              "id",
              "name",
              "description",
              "url",
              "auth_token",
              "enabled",
              "created_by",
              "created_at",
              "updated_at",
            ),
        )) as ServerRow[]
        return json(c, 201, redact(rows[0]!))
      }),
    ),

    patch(
      "/admin/mcp/servers/:id",
      authed(async c => {
        const id = Number(c.params.id)
        const body = c.body as {
          name?: string
          description?: string | null
          url?: string
          auth_token?: string | null
          authToken?: string | null
          enabled?: boolean
        }
        const row = (await db.one(from("mcp_servers").where(q => q("id").equals(id)))) as ServerRow | null
        if (!row) return json(c, 404, { error: "Server not found" })

        const update: Record<string, unknown> = { updated_at: raw("NOW()") }
        if (body.name !== undefined) {
          const n = String(body.name).trim()
          if (!n) return json(c, 422, { error: "name cannot be empty" })
          update.name = n
        }
        if (body.url !== undefined) {
          if (!isHttpUrl(body.url)) return json(c, 422, { error: "url must be a valid http(s) URL" })
          update.url = body.url
        }
        if (body.description !== undefined) update.description = body.description
        const token = body.auth_token !== undefined ? body.auth_token : body.authToken
        // undefined: don't change. null: clear. string: replace.
        if (token !== undefined) update.auth_token = token
        if (body.enabled !== undefined) update.enabled = body.enabled

        await db.execute(
          from("mcp_servers")
            .where(q => q("id").equals(id))
            .update(update),
        )
        const fresh = (await db.one(from("mcp_servers").where(q => q("id").equals(id)))) as ServerRow
        return json(c, 200, redact(fresh))
      }),
    ),

    del(
      "/admin/mcp/servers/:id",
      guard(async c => {
        const id = Number(c.params.id)
        const row = (await db.one(from("mcp_servers").where(q => q("id").equals(id)))) as ServerRow | null
        if (!row) return json(c, 404, { error: "Server not found" })
        await db.execute(
          from("mcp_servers")
            .where(q => q("id").equals(id))
            .del(),
        )
        return json(c, 200, { deleted: id })
      }),
    ),

    // Probe an existing configured server — calls initialize + tools/list to
    // confirm it's reachable and returns the advertised catalog.
    post(
      "/admin/mcp/servers/:id/probe",
      guard(async c => {
        const id = Number(c.params.id)
        const row = (await db.one(from("mcp_servers").where(q => q("id").equals(id)))) as ServerRow | null
        if (!row) return json(c, 404, { error: "Server not found" })
        const server: RemoteServer = { url: row.url, authToken: row.auth_token, timeoutMs: 10_000 }
        try {
          const init = await remoteInitialize(server)
          const tools = await remoteListTools(server)
          return json(c, 200, { ok: true, init, tools })
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return json(c, 502, { ok: false, error: msg })
        }
      }),
    ),
  ]
}
