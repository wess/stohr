import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import { emit } from "../notifications/emit.ts"

// Send a system message to a user. Used for welcome notes, account
// suspended/restored, quota warnings, owner-broadcast, etc. Fire-and-
// forget — the caller is usually inside a request handler whose primary
// operation must not be blocked by a message-table hiccup.
export const sendSystem = async (
  db: Connection,
  toUserId: number,
  subject: string,
  body: string,
): Promise<number | null> => {
  try {
    const inserted = (await db.execute(
      from("messages")
        .insert({
          thread_id: 0,
          from_user_id: null,
          to_user_id: toUserId,
          subject,
          body,
          kind: "system",
        })
        .returning("id"),
    )) as Array<{ id: number }>
    const id = inserted[0]?.id
    if (id == null) return null
    // Backfill thread_id = id for the root message; replies (which the
    // recipient cannot send back to "system") would inherit.
    await db.execute(
      from("messages")
        .where(q => q("id").equals(id))
        .update({ thread_id: id }),
    )
    void emit(db, {
      userId: toUserId,
      kind: "comment.created",
      resourceType: "comment",
      resourceId: id,
      payload: { kind: "message", subject },
    })
    return id
  } catch (err) {
    console.error("[messages] sendSystem failed:", err)
    return null
  }
}

// Broadcast a system message to every active (non-deleted) user. Used by
// the owner's "Send announcement" tool — one row per recipient so each
// user can mark-read / archive independently. Returns count delivered.
export const broadcastSystem = async (db: Connection, subject: string, body: string): Promise<number> => {
  const users = (await db.all(
    from("users")
      .where(q => q("deleted_at").isNull())
      .select("id"),
  )) as Array<{ id: number }>
  let count = 0
  for (const u of users) {
    const id = await sendSystem(db, u.id, subject, body)
    if (id) count++
  }
  return count
}

// Insert a root message and backfill its thread_id to point at itself.
// Done in two round-trips because Postgres CTE snapshots don't let a
// modifying-CTE INSERT be observed by an UPDATE in the same statement.
export const insertRootMessage = async (
  db: Connection,
  input: {
    fromUserId: number | null
    toUserId: number
    subject: string
    body: string
    kind: "user" | "system"
  },
): Promise<{ id: number; thread_id: number; created_at: string } | null> => {
  const inserted = (await db.execute(
    from("messages")
      .insert({
        thread_id: 0,
        from_user_id: input.fromUserId,
        to_user_id: input.toUserId,
        subject: input.subject,
        body: input.body,
        kind: input.kind,
      })
      .returning("id", "created_at"),
  )) as Array<{ id: number; created_at: string }>
  const row = inserted[0]
  if (!row) return null
  await db.execute(
    from("messages")
      .where(q => q("id").equals(row.id))
      .update({ thread_id: row.id }),
  )
  return { id: row.id, thread_id: row.id, created_at: row.created_at }
}
