import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"

export type AuditEvent = {
  userId?: number | null
  event: string
  metadata?: Record<string, unknown>
  ip?: string | null
  userAgent?: string | null
}

export const logEvent = (db: Connection, ev: AuditEvent): void => {
  // Fire-and-forget so audit logging never blocks the response.
  void db.execute(
    from("audit_events").insert({
      user_id: ev.userId ?? null,
      event: ev.event,
      metadata: ev.metadata ? JSON.stringify(ev.metadata) : null,
      ip: ev.ip ?? null,
      user_agent: ev.userAgent ?? null,
    }),
  ).catch((err) => {
    console.error("[audit] failed to log:", ev.event, err)
  })
}
