import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import { getPrimitive } from "../primitives/registry.ts"
import type { StepEnvelope } from "../primitives/types.ts"
import type { ActionContext, ActionResult } from "../types.ts"
import { parseUserAction, type UserActionRow } from "./types.ts"

export const loadUserAction = async (db: Connection, id: number): Promise<UserActionRow | null> => {
  const row = await db.one(from("user_actions").where(q => q("id").equals(id)))
  return (row as UserActionRow | null) ?? null
}

export const runUserAction = async (
  ctx: ActionContext,
  row: UserActionRow,
): Promise<ActionResult> => {
  if (!row.enabled) {
    return { ok: true, result: { skipped: true, reason: "user action disabled" } }
  }

  const parsed = parseUserAction(row)

  let env: StepEnvelope = {
    subject: ctx.subject,
    folder: ctx.folder,
    scratch: {},
  }
  const completed: string[] = []

  for (const step of parsed.steps) {
    const prim = getPrimitive(step.kind)
    if (!prim) return { ok: false, error: `Unknown step: ${step.kind}` }
    if (!prim.subjects.includes(env.subject.kind)) {
      return {
        ok: true,
        result: { skipped_at: step.kind, reason: `${prim.name} doesn't apply to ${env.subject.kind}`, completed },
      }
    }
    const res = await prim.run(env, step.config, {
      db: ctx.db,
      store: ctx.store,
      ownerId: ctx.ownerId,
      actor: ctx.actor,
    })
    if (res.kind === "halt") {
      return { ok: true, result: { skipped_at: step.kind, reason: res.reason, completed } }
    }
    if (res.kind === "fail") {
      return { ok: false, error: `${prim.name}: ${res.error}` }
    }
    if (res.envelope) env = res.envelope
    completed.push(step.kind)
  }

  return { ok: true, result: { completed, action_name: row.name } }
}
