import type { Connection } from "@atlas/db"
import { from, raw } from "@atlas/db"
import { del, get, json, parseJson, patch, pipeline, post } from "@atlas/server"
import { requireAuth } from "../../auth/guard.ts"
import { describePrimitive, listPrimitives } from "../primitives/registry.ts"
import { ALL_EVENTS, isEventName } from "../types.ts"
import type { EventName } from "../types.ts"
import type { Step } from "../primitives/types.ts"
import { parseUserAction, type UserActionRow } from "./types.ts"
import { formatUserSlug } from "./slug.ts"
import { cloneFor } from "./clone.ts"

const authId = (c: any) => (c.assigns.auth as { id: number }).id

const safeStringifyArray = (v: unknown): string => {
  if (!Array.isArray(v)) return "[]"
  return JSON.stringify(v)
}

const validateTriggers = (raw: unknown): { ok: true; triggers: EventName[] } | { ok: false; error: string } => {
  if (!Array.isArray(raw)) return { ok: false, error: "triggers must be an array" }
  const out: EventName[] = []
  for (const t of raw) {
    if (!isEventName(t)) return { ok: false, error: `Unknown trigger: ${t}` }
    if (out.includes(t)) continue
    out.push(t)
  }
  return { ok: true, triggers: out }
}

const validateSteps = (raw: unknown): { ok: true; steps: Step[] } | { ok: false; error: string } => {
  if (!Array.isArray(raw)) return { ok: false, error: "steps must be an array" }
  const out: Step[] = []
  for (const s of raw) {
    if (!s || typeof s !== "object" || Array.isArray(s)) return { ok: false, error: "each step must be an object" }
    const step = s as Record<string, unknown>
    if (typeof step.kind !== "string") return { ok: false, error: "step.kind must be a string" }
    const config = step.config && typeof step.config === "object" && !Array.isArray(step.config)
      ? (step.config as Record<string, unknown>)
      : {}
    out.push({ kind: step.kind, config })
  }
  return { ok: true, steps: out }
}

const serialize = (row: UserActionRow) => {
  const parsed = parseUserAction(row)
  return {
    id: row.id,
    slug: formatUserSlug(row.id),
    name: row.name,
    description: row.description,
    icon: row.icon,
    triggers: parsed.triggers,
    steps: parsed.steps,
    enabled: row.enabled,
    forked_from: row.forked_from,
    is_builtin: false,
    editable: true,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

export const userActionRoutes = (db: Connection, secret: string) => {
  const guard = pipeline(requireAuth({ secret, db }))
  const authed = pipeline(requireAuth({ secret, db }), parseJson)

  return [
    /* Public-ish: registry of primitives (not user-specific, but auth-required to keep it scoped) */
    get("/actions/primitives", guard(async (c) => {
      const items = listPrimitives().map(describePrimitive)
      return json(c, 200, { primitives: items, total: items.length })
    })),

    /* List user's actions */
    get("/me/actions", guard(async (c) => {
      const userId = authId(c)
      const rows = await db.all(
        from("user_actions")
          .where(q => q("user_id").equals(userId))
          .orderBy("created_at", "DESC"),
      ) as UserActionRow[]
      return json(c, 200, rows.map(serialize))
    })),

    /* Get one user action */
    get("/me/actions/:id", guard(async (c) => {
      const userId = authId(c)
      const id = Number(c.params.id)
      const row = await db.one(
        from("user_actions").where(q => q("id").equals(id)).where(q => q("user_id").equals(userId)),
      ) as UserActionRow | null
      if (!row) return json(c, 404, { error: "Action not found" })
      return json(c, 200, serialize(row))
    })),

    /* Create */
    post("/me/actions", authed(async (c) => {
      const userId = authId(c)
      const body = c.body as {
        name?: string
        description?: string
        icon?: string
        triggers?: unknown
        steps?: unknown
        enabled?: boolean
      }
      const name = body.name?.trim()
      if (!name) return json(c, 422, { error: "name is required" })

      const triggersV = validateTriggers(body.triggers ?? [])
      if (!triggersV.ok) return json(c, 422, { error: triggersV.error })

      const stepsV = validateSteps(body.steps ?? [])
      if (!stepsV.ok) return json(c, 422, { error: stepsV.error })

      const inserted = await db.execute(
        from("user_actions")
          .insert({
            user_id: userId,
            name,
            description: body.description?.trim() || null,
            icon: body.icon?.trim() || null,
            triggers: JSON.stringify(triggersV.triggers),
            steps: JSON.stringify(stepsV.steps),
            enabled: body.enabled !== false,
          })
          .returning(
            "id", "user_id", "name", "description", "icon",
            "triggers", "steps", "enabled", "forked_from",
            "created_at", "updated_at",
          ),
      ) as UserActionRow[]

      return json(c, 201, serialize(inserted[0]!))
    })),

    /* Update */
    patch("/me/actions/:id", authed(async (c) => {
      const userId = authId(c)
      const id = Number(c.params.id)
      const existing = await db.one(
        from("user_actions").where(q => q("id").equals(id)).where(q => q("user_id").equals(userId)),
      ) as UserActionRow | null
      if (!existing) return json(c, 404, { error: "Action not found" })

      const body = c.body as {
        name?: string
        description?: string | null
        icon?: string | null
        triggers?: unknown
        steps?: unknown
        enabled?: boolean
      }
      const updates: Record<string, unknown> = {}

      if (body.name !== undefined) {
        const name = String(body.name).trim()
        if (!name) return json(c, 422, { error: "name cannot be empty" })
        updates.name = name
      }
      if (body.description !== undefined) updates.description = body.description ? String(body.description).trim() : null
      if (body.icon !== undefined) updates.icon = body.icon ? String(body.icon).trim() : null
      if (body.triggers !== undefined) {
        const v = validateTriggers(body.triggers)
        if (!v.ok) return json(c, 422, { error: v.error })
        updates.triggers = JSON.stringify(v.triggers)
      }
      if (body.steps !== undefined) {
        const v = validateSteps(body.steps)
        if (!v.ok) return json(c, 422, { error: v.error })
        updates.steps = JSON.stringify(v.steps)
      }
      if (body.enabled !== undefined) updates.enabled = !!body.enabled

      if (Object.keys(updates).length === 0) return json(c, 422, { error: "Nothing to update" })

      updates.updated_at = raw("NOW()")

      const updated = await db.execute(
        from("user_actions").where(q => q("id").equals(id)).update(updates)
          .returning(
            "id", "user_id", "name", "description", "icon",
            "triggers", "steps", "enabled", "forked_from",
            "created_at", "updated_at",
          ),
      ) as UserActionRow[]

      return json(c, 200, serialize(updated[0]!))
    })),

    /* Delete */
    del("/me/actions/:id", guard(async (c) => {
      const userId = authId(c)
      const id = Number(c.params.id)
      const existing = await db.one(
        from("user_actions").where(q => q("id").equals(id)).where(q => q("user_id").equals(userId)).select("id"),
      ) as { id: number } | null
      if (!existing) return json(c, 404, { error: "Action not found" })

      const slug = formatUserSlug(id)
      // Cascade: drop folder_actions referencing this user action
      await db.execute(from("folder_actions").where(q => q("slug").equals(slug)).del())
      await db.execute(from("user_actions").where(q => q("id").equals(id)).del())
      return json(c, 200, { deleted: id })
    })),

    /* Clone a built-in into a user-owned action */
    post("/me/actions/from-builtin/:slug", authed(async (c) => {
      const userId = authId(c)
      const slug = `${c.params.slug}`.replace(/^@/, "") // accept "stohr/x" or "@stohr/x"
      const fullSlug = slug.includes("/") ? slug : `stohr/${slug}`

      const plan = cloneFor(fullSlug)
      if (!plan) return json(c, 404, { error: `No built-in to clone: ${fullSlug}` })

      const inserted = await db.execute(
        from("user_actions")
          .insert({
            user_id: userId,
            name: plan.name,
            description: plan.description,
            icon: plan.icon,
            triggers: JSON.stringify(plan.triggers),
            steps: JSON.stringify(plan.steps),
            enabled: true,
            forked_from: fullSlug,
          })
          .returning(
            "id", "user_id", "name", "description", "icon",
            "triggers", "steps", "enabled", "forked_from",
            "created_at", "updated_at",
          ),
      ) as UserActionRow[]

      return json(c, 201, serialize(inserted[0]!))
    })),
  ]
}

/* Surface user actions inside the existing /actions/registry response.
 * Called from src/actions/index.ts so we keep that module's existing layout
 * but give it access to the user's actions. */
export const listUserActionsForRegistry = async (db: Connection, userId: number) => {
  const rows = await db.all(
    from("user_actions").where(q => q("user_id").equals(userId)).orderBy("created_at", "ASC"),
  ) as UserActionRow[]
  return rows.map(r => {
    const parsed = parseUserAction(r)
    return {
      slug: formatUserSlug(r.id),
      id: r.id,
      name: r.name,
      description: r.description ?? "",
      icon: r.icon,
      triggers: parsed.triggers,
      steps: parsed.steps,
      forked_from: r.forked_from,
      is_builtin: false,
      editable: true,
      enabled: r.enabled,
    }
  })
}

export { ALL_EVENTS }
