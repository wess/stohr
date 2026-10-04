import type { Connection } from "@atlas/db"

export type AuditEvent = {
  userId?: number | null
  // the team the event belongs to; defaults to the actor's team when there
  // is an actor, else stays null (failed logins by ip, unknown tokens)
  teamId?: number | null
  event: string
  metadata?: Record<string, unknown>
  ip?: string | null
  userAgent?: string | null
}

export const logEvent = (db: Connection, ev: AuditEvent): void => {
  // Fire-and-forget so audit logging never blocks the response.
  void db
    .execute({
      text: `
        INSERT INTO audit_events (user_id, team_id, event, metadata, ip, user_agent)
        VALUES ($1, COALESCE($2::integer, (SELECT team_id FROM users WHERE id = $1)), $3, $4, $5, $6)
      `,
      values: [
        ev.userId ?? null,
        ev.teamId ?? null,
        ev.event,
        ev.metadata ? JSON.stringify(ev.metadata) : null,
        ev.ip ?? null,
        ev.userAgent ?? null,
      ],
    })
    .catch(err => {
      console.error("[audit] failed to log:", ev.event, err)
    })
}
