import type { Connection } from "@atlas/db"
import { from, raw } from "@atlas/db"
import type { Conn } from "@atlas/server"
import { get, halt, json, parseJson, patch, pipeline } from "@atlas/server"
import { requireAuth } from "../auth/guard.ts"
import { ownerOnly } from "../security/owner.ts"

// Owner-controlled feature toggles. Stored as JSON-encoded strings so the
// same table can hold booleans, ints, or small objects. Routes that gate on
// a setting do so at request time (not at boot) so the owner can flip
// toggles in the admin UI without restarting the API.

export const SETTING_WEBDAV_ENABLED = "webdav_enabled"
export const SETTING_FEDERATION_ENABLED = "federation_enabled"
export const SETTING_MCP_ENABLED = "mcp_enabled"
export const SETTING_MCP_TOOL_READ = "mcp_tool_read"
export const SETTING_MCP_TOOL_WRITE = "mcp_tool_write"
export const SETTING_MCP_TOOL_DELETE = "mcp_tool_delete"
export const SETTING_MCP_TOOL_SHARE = "mcp_tool_share"

// The full set of toggleable keys + their default value. New settings get
// added here; the admin endpoints reject any key not in this map so the
// table doesn't become a free-form dumping ground.
const REGISTRY = {
  [SETTING_WEBDAV_ENABLED]: { default: false, type: "boolean" as const, description: "WebDAV endpoint at /webdav. Users still need to mint a per-account WebDAV password before they can connect." },
  [SETTING_FEDERATION_ENABLED]: { default: false, type: "boolean" as const, description: "Federation features (mint, join, mount). Existing federations remain in the DB when this is off — they just stop accepting traffic until re-enabled." },
  [SETTING_MCP_ENABLED]: { default: false, type: "boolean" as const, description: "Model Context Protocol server at /mcp. When off the endpoint returns 503 regardless of per-tool toggles. AI clients (Claude Desktop, IDEs) authenticate with a PAT or OAuth access token." },
  [SETTING_MCP_TOOL_READ]: { default: true, type: "boolean" as const, description: "Expose read-only MCP tools: list folders/files, read file contents, search. Safe default — these only return data the caller's token already has access to." },
  [SETTING_MCP_TOOL_WRITE]: { default: false, type: "boolean" as const, description: "Expose write MCP tools: create folder, upload file, rename, move. Off by default — opt in once you trust the AI client and its prompts." },
  [SETTING_MCP_TOOL_DELETE]: { default: false, type: "boolean" as const, description: "Expose destructive MCP tools: trash, restore, purge. Soft-deletes go to /trash and can be restored, but purge is permanent." },
  [SETTING_MCP_TOOL_SHARE]: { default: false, type: "boolean" as const, description: "Expose sharing MCP tools: create and revoke public share links. Anything the AI shares becomes reachable without auth — keep off unless you specifically want this." },
}

type SettingKey = keyof typeof REGISTRY

export const isKnownSetting = (key: string): key is SettingKey => key in REGISTRY

export const getBoolean = async (db: Connection, key: SettingKey): Promise<boolean> => {
  if (REGISTRY[key].type !== "boolean") throw new Error(`Setting ${key} is not a boolean`)
  const row = await db.one(
    from("instance_settings").where(q => q("key").equals(key)).select("value"),
  ) as { value: string } | null
  if (!row) return REGISTRY[key].default as boolean
  try { return JSON.parse(row.value) === true } catch { return REGISTRY[key].default as boolean }
}

const setRaw = async (db: Connection, key: SettingKey, value: unknown, updatedBy: number | null): Promise<void> => {
  const encoded = JSON.stringify(value)
  await db.execute({
    text: `INSERT INTO instance_settings (key, value, updated_by) VALUES ($1, $2, $3)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
    values: [key, encoded, updatedBy],
  })
}

const authId = (c: any) => (c.assigns.auth as { id: number }).id

// Pipeline guard that 503s when a feature is disabled. Cheap — one indexed
// PK lookup per request. Federation traffic and WebDAV mounts are not
// hot paths, so re-querying on every request is fine.
export const requireSettingEnabled = (db: Connection, key: SettingKey) => async (conn: Conn): Promise<Conn> => {
  const enabled = await getBoolean(db, key)
  if (!enabled) {
    return halt(conn, 503, { error: `${key} is disabled on this instance. Ask the owner to enable it in Admin → Settings.` })
  }
  return conn
}

// HTTP Basic auth on the WebDAV root produces a different failure mode —
// returning the WWW-Authenticate header so the OS client doesn't infinitely
// retry. requireSettingEnabled gives a plain 503.
export const requireSettingEnabledBasic = (db: Connection, key: SettingKey) => async (conn: Conn): Promise<Conn> => {
  const enabled = await getBoolean(db, key)
  if (!enabled) {
    return halt(conn, 503, { error: `${key} is disabled on this instance` })
  }
  return conn
}

export const adminSettingsRoutes = (db: Connection, secret: string) => {
  const ownerCheck = ownerOnly(db)
  const guard = pipeline(requireAuth({ secret, db, noOAuth: true }), ownerCheck)
  const authed = pipeline(requireAuth({ secret, db, noOAuth: true }), ownerCheck, parseJson)

  return [
    get("/admin/settings", guard(async (c) => {
      const rows = await db.all(
        from("instance_settings").select("key", "value", "updated_by", "updated_at"),
      ) as Array<{ key: string; value: string; updated_by: number | null; updated_at: string }>
      const byKey = new Map(rows.map(r => [r.key, r]))

      const settings = Object.entries(REGISTRY).map(([key, meta]) => {
        const row = byKey.get(key)
        let parsed: unknown = meta.default
        if (row) { try { parsed = JSON.parse(row.value) } catch { parsed = meta.default } }
        return {
          key,
          value: parsed,
          type: meta.type,
          description: meta.description,
          default: meta.default,
          updated_by: row?.updated_by ?? null,
          updated_at: row?.updated_at ?? null,
        }
      })
      return json(c, 200, settings)
    })),

    patch("/admin/settings", authed(async (c) => {
      const userId = authId(c)
      const body = c.body as Record<string, unknown>
      const updates: Array<{ key: SettingKey; value: unknown }> = []
      for (const [key, value] of Object.entries(body)) {
        if (!isKnownSetting(key)) return json(c, 422, { error: `Unknown setting key: ${key}` })
        const meta = REGISTRY[key]
        if (meta.type === "boolean" && typeof value !== "boolean") {
          return json(c, 422, { error: `${key} must be a boolean` })
        }
        updates.push({ key, value })
      }
      if (updates.length === 0) return json(c, 422, { error: "Nothing to update" })
      for (const u of updates) await setRaw(db, u.key, u.value, userId)
      return json(c, 200, { updated: updates.map(u => u.key) })
    })),
  ]
}

// Convenience read helpers used by other modules' route gates.
export const webdavEnabled = (db: Connection) => getBoolean(db, SETTING_WEBDAV_ENABLED)
export const federationEnabled = (db: Connection) => getBoolean(db, SETTING_FEDERATION_ENABLED)
export const mcpEnabled = (db: Connection) => getBoolean(db, SETTING_MCP_ENABLED)
export const mcpToolEnabled = (db: Connection, category: "read" | "write" | "delete" | "share") => {
  const key = category === "read" ? SETTING_MCP_TOOL_READ
    : category === "write" ? SETTING_MCP_TOOL_WRITE
    : category === "delete" ? SETTING_MCP_TOOL_DELETE
    : SETTING_MCP_TOOL_SHARE
  return getBoolean(db, key)
}

// Seed a setting at first boot. Used during env-var-to-DB migration so
// existing instances that were running with WEBDAV_ENABLED=true don't get
// their WebDAV silently turned off after upgrade.
export const seedIfMissing = async (db: Connection, key: SettingKey, value: unknown): Promise<void> => {
  await db.execute({
    text: `INSERT INTO instance_settings (key, value, updated_by) VALUES ($1, $2, NULL)
           ON CONFLICT (key) DO NOTHING`,
    values: [key, JSON.stringify(value)],
  })
}
