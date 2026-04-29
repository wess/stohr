import type { Connection } from "@atlas/db"
import { from, raw } from "@atlas/db"
import { del, get, json, parseJson, patch, pipeline, post } from "@atlas/server"
import { requireAuth } from "../auth/guard.ts"
import { folderAccess, isOwner } from "../permissions/index.ts"
import { describeAction, getAction, listActions } from "./registry.ts"
import { ALL_EVENTS, isEventName } from "./types.ts"
import type { FolderActionRow, FolderActionRunRow } from "./types.ts"
import { listUserActionsForRegistry } from "./user/index.ts"

const authId = (c: any) => (c.assigns.auth as { id: number }).id

const safeParse = (raw: string): unknown => {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

const serializeAction = (row: FolderActionRow) => ({
  id: row.id,
  folder_id: row.folder_id,
  event: row.event,
  slug: row.slug,
  config: safeParse(row.config) ?? {},
  enabled: row.enabled,
  created_at: row.created_at,
  updated_at: row.updated_at,
})

const serializeRun = (row: FolderActionRunRow) => ({
  id: row.id,
  folder_action_id: row.folder_action_id,
  triggered_event: row.triggered_event,
  subject_kind: row.subject_kind,
  subject_id: row.subject_id,
  status: row.status,
  started_at: row.started_at,
  finished_at: row.finished_at,
  error: row.error,
  result: row.result ? safeParse(row.result) : null,
})

export const actionRoutes = (db: Connection, secret: string) => {
  const guard = pipeline(requireAuth({ secret, db }))
  const authed = pipeline(requireAuth({ secret, db }), parseJson)

  return [
    get("/actions/registry", guard(async (c) => {
      const userId = authId(c)
      const builtins = listActions().map(a => ({
        ...describeAction(a),
        is_builtin: true,
        editable: false,
      }))
      const userActions = await listUserActionsForRegistry(db, userId)
      const all = [...builtins, ...userActions]
      return json(c, 200, { actions: all, total: all.length })
    })),

    get("/folders/:id/actions", guard(async (c) => {
      const userId = authId(c)
      const id = Number(c.params.id)
      const access = await folderAccess(db, userId, id)
      if (!access) return json(c, 404, { error: "Folder not found" })

      const rows = await db.all(
        from("folder_actions")
          .where(q => q("folder_id").equals(id))
          .orderBy("created_at", "ASC"),
      ) as FolderActionRow[]

      return json(c, 200, rows.map(serializeAction))
    })),

    post("/folders/:id/actions", authed(async (c) => {
      const userId = authId(c)
      const id = Number(c.params.id)
      const access = await folderAccess(db, userId, id)
      if (!access) return json(c, 404, { error: "Folder not found" })
      if (!isOwner(access.role)) return json(c, 403, { error: "Only the folder owner can configure actions" })

      const body = c.body as { event?: string; slug?: string; config?: unknown; enabled?: boolean }
      const event = body.event
      const slug = body.slug
      if (!event || !isEventName(event)) {
        return json(c, 422, { error: `event must be one of: ${ALL_EVENTS.join(", ")}` })
      }
      if (!slug || typeof slug !== "string") return json(c, 422, { error: "slug required" })

      const action = getAction(slug)
      if (!action) return json(c, 422, { error: `Unknown action slug: ${slug}` })
      if (!action.events.includes(event)) {
        return json(c, 422, { error: `Action ${slug} does not handle event ${event}` })
      }

      const config = body.config && typeof body.config === "object" && !Array.isArray(body.config)
        ? body.config as Record<string, unknown>
        : {}
      const enabled = body.enabled !== false

      const inserted = await db.execute(
        from("folder_actions")
          .insert({
            folder_id: id,
            event,
            slug,
            config: JSON.stringify(config),
            enabled,
          })
          .returning("id", "folder_id", "event", "slug", "config", "enabled", "created_at", "updated_at"),
      ) as FolderActionRow[]

      return json(c, 201, serializeAction(inserted[0]!))
    })),

    patch("/folders/:id/actions/:aid", authed(async (c) => {
      const userId = authId(c)
      const id = Number(c.params.id)
      const aid = Number(c.params.aid)
      const access = await folderAccess(db, userId, id)
      if (!access) return json(c, 404, { error: "Folder not found" })
      if (!isOwner(access.role)) return json(c, 403, { error: "Only the folder owner can configure actions" })

      const existing = await db.one(
        from("folder_actions")
          .where(q => q("id").equals(aid))
          .where(q => q("folder_id").equals(id)),
      ) as FolderActionRow | null
      if (!existing) return json(c, 404, { error: "Action not found" })

      const body = c.body as { event?: string; config?: unknown; enabled?: boolean }
      const updates: Record<string, unknown> = {}

      if (body.event !== undefined) {
        if (!isEventName(body.event)) {
          return json(c, 422, { error: `event must be one of: ${ALL_EVENTS.join(", ")}` })
        }
        const action = getAction(existing.slug)
        if (action && !action.events.includes(body.event)) {
          return json(c, 422, { error: `Action ${existing.slug} does not handle event ${body.event}` })
        }
        updates.event = body.event
      }

      if (body.config !== undefined) {
        if (!body.config || typeof body.config !== "object" || Array.isArray(body.config)) {
          return json(c, 422, { error: "config must be an object" })
        }
        updates.config = JSON.stringify(body.config)
      }

      if (body.enabled !== undefined) updates.enabled = !!body.enabled

      if (Object.keys(updates).length === 0) return json(c, 422, { error: "Nothing to update" })

      updates.updated_at = raw("NOW()")

      const updated = await db.execute(
        from("folder_actions")
          .where(q => q("id").equals(aid))
          .update(updates)
          .returning("id", "folder_id", "event", "slug", "config", "enabled", "created_at", "updated_at"),
      ) as FolderActionRow[]

      return json(c, 200, serializeAction(updated[0]!))
    })),

    del("/folders/:id/actions/:aid", guard(async (c) => {
      const userId = authId(c)
      const id = Number(c.params.id)
      const aid = Number(c.params.aid)
      const access = await folderAccess(db, userId, id)
      if (!access) return json(c, 404, { error: "Folder not found" })
      if (!isOwner(access.role)) return json(c, 403, { error: "Only the folder owner can configure actions" })

      const existing = await db.one(
        from("folder_actions")
          .where(q => q("id").equals(aid))
          .where(q => q("folder_id").equals(id))
          .select("id"),
      ) as { id: number } | null
      if (!existing) return json(c, 404, { error: "Action not found" })

      await db.execute(from("folder_actions").where(q => q("id").equals(aid)).del())
      return json(c, 200, { deleted: aid })
    })),

    get("/folders/:id/actions/runs", guard(async (c) => {
      const userId = authId(c)
      const id = Number(c.params.id)
      const access = await folderAccess(db, userId, id)
      if (!access) return json(c, 404, { error: "Folder not found" })

      const url = new URL(c.request.url)
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 50)))

      const actions = await db.all(
        from("folder_actions")
          .where(q => q("folder_id").equals(id))
          .select("id"),
      ) as Array<{ id: number }>
      const ids = actions.map(a => a.id)
      if (ids.length === 0) return json(c, 200, [])

      const rows = await db.all(
        from("folder_action_runs")
          .where(q => q("folder_action_id").inList(ids))
          .orderBy("started_at", "DESC")
          .limit(limit),
      ) as FolderActionRunRow[]

      return json(c, 200, rows.map(serializeRun))
    })),
  ]
}
