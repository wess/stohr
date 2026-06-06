import type { Connection } from "@atlas/db"
import { from, raw } from "@atlas/db"
import { del, get, json, parseJson, patch, pipeline, post } from "@atlas/server"
import { requireAuth } from "../auth/guard.ts"
import { emitMany } from "../notifications/emit.ts"
import { canWrite, fileAccess, folderAccess, type Role } from "../permissions/index.ts"

const authId = (c: any) => (c.assigns.auth as { id: number }).id

const MAX_BODY = 8000
const MIN_BODY = 1

type CommentRow = {
  id: number
  resource_type: string
  resource_id: number
  user_id: number
  parent_id: number | null
  body: string
  edited_at: string | null
  deleted_at: string | null
  created_at: string
}

type ResourceKind = "file" | "folder"

const resolveResource = async (
  db: Connection,
  userId: number,
  kind: ResourceKind,
  id: number,
): Promise<{ role: Role; ownerId: number } | null> => {
  if (kind === "folder") {
    const got = await folderAccess(db, userId, id)
    if (!got) return null
    return { role: got.role, ownerId: got.folder.user_id }
  }
  const got = await fileAccess(db, userId, id)
  if (!got) return null
  return { role: got.role, ownerId: got.file.user_id }
}

const hydrate = (row: CommentRow & { author_name?: string; author_username?: string }) => ({
  id: row.id,
  resource_type: row.resource_type,
  resource_id: row.resource_id,
  parent_id: row.parent_id,
  body: row.deleted_at ? "" : row.body,
  user: {
    id: row.user_id,
    name: row.author_name ?? null,
    username: row.author_username ?? null,
  },
  edited_at: row.edited_at,
  deleted_at: row.deleted_at,
  created_at: row.created_at,
})

const listForResource = async (db: Connection, kind: ResourceKind, id: number) => {
  const rows = (await db.execute({
    text: `
      SELECT c.id, c.resource_type, c.resource_id, c.user_id, c.parent_id,
             c.body, c.edited_at, c.deleted_at, c.created_at,
             u.name AS author_name, u.username AS author_username
        FROM comments c
        LEFT JOIN users u ON u.id = c.user_id
       WHERE c.resource_type = $1 AND c.resource_id = $2
       ORDER BY c.created_at ASC
    `,
    values: [kind, id],
  })) as Array<CommentRow & { author_name: string; author_username: string }>
  return rows.map(hydrate)
}

const participantsFor = async (db: Connection, kind: ResourceKind, id: number): Promise<number[]> => {
  const rows = (await db.execute({
    text: `
      SELECT DISTINCT user_id FROM comments
       WHERE resource_type = $1 AND resource_id = $2 AND deleted_at IS NULL
    `,
    values: [kind, id],
  })) as Array<{ user_id: number }>
  return rows.map(r => r.user_id)
}

export const commentRoutes = (db: Connection, secret: string) => {
  const guard = pipeline(requireAuth({ secret, db }))
  const authed = pipeline(requireAuth({ secret, db }), parseJson)

  return [
    // Two GET shapes — one per resource kind — so the URL space mirrors
    // the existing /files/:id/... and /folders/:id/... layout.
    get(
      "/files/:id/comments",
      guard(async c => {
        const userId = authId(c)
        const id = Number(c.params.id)
        const access = await resolveResource(db, userId, "file", id)
        if (!access) return json(c, 404, { error: "Not found" })
        const rows = await listForResource(db, "file", id)
        return json(c, 200, { comments: rows })
      }),
    ),

    get(
      "/folders/:id/comments",
      guard(async c => {
        const userId = authId(c)
        const id = Number(c.params.id)
        const access = await resolveResource(db, userId, "folder", id)
        if (!access) return json(c, 404, { error: "Not found" })
        const rows = await listForResource(db, "folder", id)
        return json(c, 200, { comments: rows })
      }),
    ),

    post(
      "/files/:id/comments",
      authed(async c => createComment(c, db, "file")),
    ),
    post(
      "/folders/:id/comments",
      authed(async c => createComment(c, db, "folder")),
    ),

    patch(
      "/comments/:id",
      authed(async c => {
        const userId = authId(c)
        const id = Number(c.params.id)
        const body = (c.body as { body?: string }).body?.trim() ?? ""
        if (body.length < MIN_BODY || body.length > MAX_BODY) {
          return json(c, 422, { error: `body must be ${MIN_BODY}-${MAX_BODY} chars` })
        }
        const row = (await db.one(
          from("comments")
            .where(q => q("id").equals(id))
            .select("id", "user_id", "deleted_at"),
        )) as { id: number; user_id: number; deleted_at: string | null } | null
        if (!row || row.deleted_at) return json(c, 404, { error: "Comment not found" })
        if (row.user_id !== userId) return json(c, 403, { error: "Not your comment" })
        await db.execute(
          from("comments")
            .where(q => q("id").equals(id))
            .update({
              body,
              edited_at: raw("NOW()"),
            }),
        )
        return json(c, 200, { ok: true })
      }),
    ),

    del(
      "/comments/:id",
      guard(async c => {
        const userId = authId(c)
        const id = Number(c.params.id)
        const row = (await db.one(
          from("comments")
            .where(q => q("id").equals(id))
            .select("id", "user_id", "resource_type", "resource_id", "deleted_at"),
        )) as {
          id: number
          user_id: number
          resource_type: string
          resource_id: number
          deleted_at: string | null
        } | null
        if (!row || row.deleted_at) return json(c, 404, { error: "Comment not found" })

        // Author can always delete their own. The resource owner can delete
        // anyone's comment on their resource. Editors cannot delete others.
        if (row.user_id !== userId) {
          const access = await resolveResource(db, userId, row.resource_type as ResourceKind, row.resource_id)
          if (!access || access.role !== "owner") {
            return json(c, 403, { error: "Cannot delete this comment" })
          }
        }
        await db.execute(
          from("comments")
            .where(q => q("id").equals(id))
            .update({ deleted_at: raw("NOW()") }),
        )
        return json(c, 200, { ok: true })
      }),
    ),
  ]
}

const createComment = async (c: any, db: Connection, kind: ResourceKind) => {
  const userId = authId(c)
  const id = Number(c.params.id)
  const body = (c.body as { body?: string; parent_id?: number; parentId?: number }).body?.trim() ?? ""
  const parentId = (c.body as any).parent_id ?? (c.body as any).parentId ?? null

  if (body.length < MIN_BODY || body.length > MAX_BODY) {
    return json(c, 422, { error: `body must be ${MIN_BODY}-${MAX_BODY} chars` })
  }
  const access = await resolveResource(db, userId, kind, id)
  if (!access) return json(c, 404, { error: "Not found" })
  if (!canWrite(access.role) && access.role !== "viewer") {
    return json(c, 403, { error: "No access" })
  }
  // Viewers can leave comments — that's the point of comments. Only
  // editors+ can edit/delete (the comment author can always edit their own).

  if (parentId) {
    const parent = await db.one(
      from("comments")
        .where(q => q("id").equals(Number(parentId)))
        .where(q => q("resource_type").equals(kind))
        .where(q => q("resource_id").equals(id))
        .select("id"),
    )
    if (!parent) return json(c, 422, { error: "Parent comment not found on this resource" })
  }

  const inserted = (await db.execute(
    from("comments")
      .insert({
        resource_type: kind,
        resource_id: id,
        user_id: userId,
        parent_id: parentId ? Number(parentId) : null,
        body,
      })
      .returning(
        "id",
        "resource_type",
        "resource_id",
        "user_id",
        "parent_id",
        "body",
        "edited_at",
        "deleted_at",
        "created_at",
      ),
  )) as CommentRow[]
  const row = inserted[0]!

  // Notify the resource owner + every other previous commenter on the
  // same resource. We do this synchronously but the emit helper swallows
  // its own errors so a failed insert never blocks the comment.
  const participants = await participantsFor(db, kind, id)
  const recipients = new Set<number>([access.ownerId, ...participants])
  recipients.delete(userId)
  await emitMany(
    db,
    Array.from(recipients).map(uid => ({
      userId: uid,
      kind: parentId ? ("comment.reply" as const) : ("comment.created" as const),
      resourceType: kind,
      resourceId: id,
      actorId: userId,
      payload: { comment_id: row.id, parent_id: row.parent_id },
    })),
  )

  return json(c, 201, hydrate(row))
}
