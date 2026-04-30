import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import { enqueue } from "../jobs/index.ts"
import { log } from "../log/index.ts"

// Emit an event to every enabled webhook for `userId` whose event filter
// matches `event`. Each (webhook, event) pair becomes one delivery row + one
// queued job, which the job runner will then POST.
//
// Filter semantics: empty events array means "all events". Otherwise an
// exact-string match against the event name, or a wildcard prefix like
// "file.*" matching everything under "file.".

type WebhookRow = {
  id: number
  user_id: number
  url: string
  events: string[] | string | null
  enabled: boolean
}

const matchesFilter = (filters: string[], event: string): boolean => {
  if (filters.length === 0) return true
  for (const f of filters) {
    if (f === event) return true
    if (f.endsWith("*") && event.startsWith(f.slice(0, -1))) return true
  }
  return false
}

export type EmitInput = {
  userId: number
  event: string
  payload: Record<string, unknown>
}

export const emitEvent = async (db: Connection, input: EmitInput): Promise<void> => {
  try {
    const hooks = await db.all(
      from("webhooks")
        .where(q => q("user_id").equals(input.userId))
        .where(q => q("enabled").equals(true))
        .select("id", "user_id", "url", "events", "enabled"),
    ) as WebhookRow[]

    if (hooks.length === 0) return

    for (const h of hooks) {
      const filters = Array.isArray(h.events)
        ? h.events
        : typeof h.events === "string" && h.events.length > 0
          ? (() => { try { return JSON.parse(h.events as string) } catch { return [] } })()
          : []
      if (!matchesFilter(filters, input.event)) continue

      const rows = await db.execute(
        from("webhook_deliveries").insert({
          webhook_id: h.id,
          event: input.event,
          payload: JSON.stringify(input.payload),
        }).returning("id"),
      ) as Array<{ id: number | string }>
      const deliveryId = Number(rows[0]!.id)
      await enqueue(db, "webhook.deliver", { delivery_id: deliveryId }, { maxAttempts: 6 })
    }
  } catch (err) {
    // Webhook emission must never fail the parent operation. Audit-style.
    log.error("webhook emit failed", { event: input.event, err: err instanceof Error ? err.message : String(err) })
  }
}
