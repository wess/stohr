import type { Connection } from "@atlas/db"
import { from, raw } from "@atlas/db"
import { del, get, json, parseJson, pipeline, post } from "@atlas/server"
import { requireAuth } from "../auth/guard.ts"
import { emit } from "../notifications/emit.ts"
import { insertRootMessage } from "./system.ts"

const authId = (c: any) => (c.assigns.auth as { id: number }).id

const SUBJECT_MAX = 200
const BODY_MAX = 50_000

type MessageRow = {
  id: number
  thread_id: number
  parent_id: number | null
  from_user_id: number | null
  to_user_id: number
  subject: string
  body: string
  kind: "user" | "system"
  read_at: string | null
  archived_at: string | null
  deleted_at: string | null
  created_at: string
  from_username: string | null
  from_name: string | null
  to_username: string | null
  to_name: string | null
}

const hydrate = (row: MessageRow) => ({
  id: row.id,
  thread_id: row.thread_id,
  parent_id: row.parent_id,
  from: row.from_user_id == null ? null : { id: row.from_user_id, username: row.from_username, name: row.from_name },
  to: { id: row.to_user_id, username: row.to_username, name: row.to_name },
  subject: row.subject,
  body: row.body,
  kind: row.kind,
  read_at: row.read_at,
  archived_at: row.archived_at,
  created_at: row.created_at,
})

const listInbox = async (db: Connection, userId: number, opts: { archived: boolean; limit: number }) => {
  return db.execute({
    text: `
      SELECT m.id, m.thread_id, m.parent_id, m.from_user_id, m.to_user_id,
             m.subject, m.body, m.kind, m.read_at, m.archived_at,
             m.deleted_at, m.created_at,
             fu.username AS from_username, fu.name AS from_name,
             tu.username AS to_username, tu.name AS to_name
        FROM messages m
        LEFT JOIN users fu ON fu.id = m.from_user_id
        LEFT JOIN users tu ON tu.id = m.to_user_id
       WHERE m.to_user_id = $1
         AND m.deleted_at IS NULL
         AND (CASE WHEN $2::boolean THEN m.archived_at IS NOT NULL ELSE m.archived_at IS NULL END)
       ORDER BY m.created_at DESC
       LIMIT $3
    `,
    values: [userId, opts.archived, opts.limit],
  }) as Promise<MessageRow[]>
}

const listSent = async (db: Connection, userId: number, limit: number) => {
  return db.execute({
    text: `
      SELECT m.id, m.thread_id, m.parent_id, m.from_user_id, m.to_user_id,
             m.subject, m.body, m.kind, m.read_at, m.archived_at,
             m.deleted_at, m.created_at,
             fu.username AS from_username, fu.name AS from_name,
             tu.username AS to_username, tu.name AS to_name
        FROM messages m
        LEFT JOIN users fu ON fu.id = m.from_user_id
        LEFT JOIN users tu ON tu.id = m.to_user_id
       WHERE m.from_user_id = $1
         AND m.deleted_at IS NULL
       ORDER BY m.created_at DESC
       LIMIT $2
    `,
    values: [userId, limit],
  }) as Promise<MessageRow[]>
}

const loadThread = async (db: Connection, userId: number, threadId: number) => {
  // Caller must be either the sender or recipient of at least one message
  // in the thread. We check up-front so the thread doesn't leak via the
  // id (which is sequential).
  const ok = (await db.one({
    text: `
      SELECT 1 FROM messages
       WHERE thread_id = $1
         AND (to_user_id = $2 OR from_user_id = $2)
       LIMIT 1
    `,
    values: [threadId, userId],
  })) as { "?column?": number } | null
  if (!ok) return null
  return db.execute({
    text: `
      SELECT m.id, m.thread_id, m.parent_id, m.from_user_id, m.to_user_id,
             m.subject, m.body, m.kind, m.read_at, m.archived_at,
             m.deleted_at, m.created_at,
             fu.username AS from_username, fu.name AS from_name,
             tu.username AS to_username, tu.name AS to_name
        FROM messages m
        LEFT JOIN users fu ON fu.id = m.from_user_id
        LEFT JOIN users tu ON tu.id = m.to_user_id
       WHERE m.thread_id = $1
         AND m.deleted_at IS NULL
       ORDER BY m.created_at ASC
    `,
    values: [threadId],
  }) as Promise<MessageRow[]>
}

const resolveRecipient = async (
  db: Connection,
  input: { user_id?: number; userId?: number; username?: string; email?: string },
): Promise<{ id: number } | null> => {
  const id = input.user_id ?? input.userId
  if (id) {
    return (await db.one(
      from("users")
        .where(q => q("id").equals(id))
        .where(q => q("deleted_at").isNull())
        .select("id"),
    )) as { id: number } | null
  }
  const username = input.username
  if (username) {
    return (await db.one(
      from("users")
        .where(q => q("username").equals(username.toLowerCase()))
        .where(q => q("deleted_at").isNull())
        .select("id"),
    )) as { id: number } | null
  }
  const email = input.email
  if (email) {
    return (await db.one(
      from("users")
        .where(q => q("email").equals(email.toLowerCase()))
        .where(q => q("deleted_at").isNull())
        .select("id"),
    )) as { id: number } | null
  }
  return null
}

export const messageRoutes = (db: Connection, secret: string) => {
  const guard = pipeline(requireAuth({ secret, db }))
  const authed = pipeline(requireAuth({ secret, db }), parseJson)

  return [
    get(
      "/me/messages",
      guard(async c => {
        const userId = authId(c)
        const url = new URL(c.request.url)
        const box = url.searchParams.get("box") ?? "inbox"
        const limitRaw = Number(url.searchParams.get("limit") ?? "100")
        const limit = Math.max(1, Math.min(Number.isFinite(limitRaw) ? Math.floor(limitRaw) : 100, 200))

        let rows: MessageRow[]
        if (box === "sent") rows = await listSent(db, userId, limit)
        else if (box === "archived") rows = await listInbox(db, userId, { archived: true, limit })
        else rows = await listInbox(db, userId, { archived: false, limit })

        const unread = (await db.one({
          text: `SELECT COUNT(*)::int AS n FROM messages WHERE to_user_id = $1 AND read_at IS NULL AND deleted_at IS NULL AND archived_at IS NULL`,
          values: [userId],
        })) as { n: number }

        return json(c, 200, {
          messages: rows.map(hydrate),
          unread: unread.n,
        })
      }),
    ),

    get(
      "/me/messages/unread-count",
      guard(async c => {
        const userId = authId(c)
        const row = (await db.one({
          text: `SELECT COUNT(*)::int AS n FROM messages WHERE to_user_id = $1 AND read_at IS NULL AND deleted_at IS NULL AND archived_at IS NULL`,
          values: [userId],
        })) as { n: number }
        return json(c, 200, { unread: row.n })
      }),
    ),

    get(
      "/me/messages/thread/:threadId",
      guard(async c => {
        const userId = authId(c)
        const threadId = Number(c.params.threadId)
        const rows = await loadThread(db, userId, threadId)
        if (!rows) return json(c, 404, { error: "Thread not found" })
        // Auto-mark-read any messages addressed to me in this thread.
        await db.execute(
          from("messages")
            .where(q => q("thread_id").equals(threadId))
            .where(q => q("to_user_id").equals(userId))
            .where(q => q("read_at").isNull())
            .update({ read_at: raw("NOW()") }),
        )
        return json(c, 200, { messages: rows.map(hydrate) })
      }),
    ),

    post(
      "/me/messages",
      authed(async c => {
        const userId = authId(c)
        const body = c.body as {
          to_user_id?: number
          toUserId?: number
          username?: string
          email?: string
          subject?: string
          body?: string
        }
        const subject = body.subject?.trim() ?? ""
        const messageBody = body.body?.trim() ?? ""
        if (!subject || subject.length > SUBJECT_MAX) {
          return json(c, 422, { error: `subject must be 1-${SUBJECT_MAX} chars` })
        }
        if (!messageBody || messageBody.length > BODY_MAX) {
          return json(c, 422, { error: `body must be 1-${BODY_MAX} chars` })
        }

        const recipient = await resolveRecipient(db, body)
        if (!recipient) return json(c, 404, { error: "Recipient not found" })
        if (recipient.id === userId) return json(c, 422, { error: "Cannot send a message to yourself" })

        const row = await insertRootMessage(db, {
          fromUserId: userId,
          toUserId: recipient.id,
          subject,
          body: messageBody,
          kind: "user",
        })
        if (!row) return json(c, 500, { error: "Failed to create message" })

        void emit(db, {
          userId: recipient.id,
          kind: "comment.created",
          resourceType: "comment",
          resourceId: row.id,
          actorId: userId,
          payload: { kind: "message", subject },
        })

        return json(c, 201, { id: row.id, thread_id: row.thread_id, created_at: row.created_at })
      }),
    ),

    post(
      "/me/messages/:id/reply",
      authed(async c => {
        const userId = authId(c)
        const id = Number(c.params.id)
        const body = (c.body as { body?: string }).body?.trim() ?? ""
        if (!body || body.length > BODY_MAX) {
          return json(c, 422, { error: `body must be 1-${BODY_MAX} chars` })
        }

        const target = (await db.one(
          from("messages")
            .where(q => q("id").equals(id))
            .select("id", "thread_id", "from_user_id", "to_user_id", "subject", "kind", "deleted_at"),
        )) as {
          id: number
          thread_id: number
          from_user_id: number | null
          to_user_id: number
          subject: string
          kind: string
          deleted_at: string | null
        } | null
        if (!target || target.deleted_at) return json(c, 404, { error: "Message not found" })
        // Caller must be in the thread (sender or recipient of this row).
        if (target.from_user_id !== userId && target.to_user_id !== userId) {
          return json(c, 403, { error: "Not your thread" })
        }
        // Cannot reply to a system message — there's no human on the other end.
        if (target.kind === "system" || target.from_user_id == null) {
          return json(c, 422, { error: "Cannot reply to a system message" })
        }
        const recipientId = target.from_user_id === userId ? target.to_user_id : target.from_user_id

        const inserted = (await db.execute(
          from("messages")
            .insert({
              thread_id: target.thread_id,
              parent_id: target.id,
              from_user_id: userId,
              to_user_id: recipientId,
              subject: target.subject.startsWith("Re: ") ? target.subject : `Re: ${target.subject}`,
              body,
              kind: "user",
            })
            .returning("id", "created_at"),
        )) as Array<{ id: number; created_at: string }>
        const row = inserted[0]!

        void emit(db, {
          userId: recipientId,
          kind: "comment.reply",
          resourceType: "comment",
          resourceId: row.id,
          actorId: userId,
          payload: { kind: "message", thread_id: target.thread_id },
        })

        return json(c, 201, { id: row.id, thread_id: target.thread_id, created_at: row.created_at })
      }),
    ),

    post(
      "/me/messages/:id/read",
      authed(async c => {
        const userId = authId(c)
        const id = Number(c.params.id)
        await db.execute(
          from("messages")
            .where(q => q("id").equals(id))
            .where(q => q("to_user_id").equals(userId))
            .where(q => q("read_at").isNull())
            .update({ read_at: raw("NOW()") }),
        )
        return json(c, 200, { ok: true })
      }),
    ),

    post(
      "/me/messages/read-all",
      authed(async c => {
        const userId = authId(c)
        await db.execute(
          from("messages")
            .where(q => q("to_user_id").equals(userId))
            .where(q => q("read_at").isNull())
            .update({ read_at: raw("NOW()") }),
        )
        return json(c, 200, { ok: true })
      }),
    ),

    post(
      "/me/messages/:id/archive",
      authed(async c => {
        const userId = authId(c)
        const id = Number(c.params.id)
        await db.execute(
          from("messages")
            .where(q => q("id").equals(id))
            .where(q => q("to_user_id").equals(userId))
            .update({ archived_at: raw("NOW()") }),
        )
        return json(c, 200, { ok: true })
      }),
    ),

    post(
      "/me/messages/:id/unarchive",
      authed(async c => {
        const userId = authId(c)
        const id = Number(c.params.id)
        await db.execute(
          from("messages")
            .where(q => q("id").equals(id))
            .where(q => q("to_user_id").equals(userId))
            .update({ archived_at: null }),
        )
        return json(c, 200, { ok: true })
      }),
    ),

    del(
      "/me/messages/:id",
      guard(async c => {
        const userId = authId(c)
        const id = Number(c.params.id)
        // Soft-delete only from the requester's side. The other party's
        // row is a separate INSERT in normal flow (reply), but for the
        // initial send we have a single row with two parties — we still
        // soft-delete only when called by the recipient. The sender's
        // soft-delete is a no-op here; that ergonomic is handled by
        // archiving from /sent.
        await db.execute(
          from("messages")
            .where(q => q("id").equals(id))
            .where(q => q("to_user_id").equals(userId))
            .update({ deleted_at: raw("NOW()") }),
        )
        return json(c, 200, { ok: true })
      }),
    ),
  ]
}
