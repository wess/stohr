import type { Connection } from "@atlas/db"
import { get, json, pipeline } from "@atlas/server"
import { requireAuth } from "../auth/guard.ts"
import { fileAccess, folderAccess } from "../permissions/index.ts"

const authId = (c: any) => (c.assigns.auth as { id: number }).id

// Activity events the user sees on a resource page. We synthesize them
// from existing tables rather than introducing a dedicated activity log —
// audit_events has the system-level record, comments live in their own
// table, collaborations are events too.
type Activity = {
  kind: "comment" | "collab" | "version" | "share"
  at: string
  actor: { id: number | null; username: string | null; name: string | null }
  detail: Record<string, unknown>
}

const fileActivity = async (db: Connection, fileId: number): Promise<Activity[]> => {
  const rows: Activity[] = []

  const comments = (await db.execute({
    text: `
      SELECT c.id, c.body, c.created_at, c.deleted_at, c.user_id,
             u.username, u.name
        FROM comments c
        LEFT JOIN users u ON u.id = c.user_id
       WHERE c.resource_type = 'file' AND c.resource_id = $1
       ORDER BY c.created_at DESC
       LIMIT 100
    `,
    values: [fileId],
  })) as Array<{
    id: number
    body: string
    created_at: string
    deleted_at: string | null
    user_id: number
    username: string
    name: string
  }>
  for (const r of comments) {
    rows.push({
      kind: "comment",
      at: r.created_at,
      actor: { id: r.user_id, username: r.username, name: r.name },
      detail: { comment_id: r.id, deleted: !!r.deleted_at, body: r.deleted_at ? null : r.body },
    })
  }

  const versions = (await db.execute({
    text: `
      SELECT v.id, v.version, v.uploaded_at, v.uploaded_by, v.size,
             u.username, u.name
        FROM file_versions v
        LEFT JOIN users u ON u.id = v.uploaded_by
       WHERE v.file_id = $1
       ORDER BY v.uploaded_at DESC
       LIMIT 50
    `,
    values: [fileId],
  })) as Array<{
    id: number
    version: number
    uploaded_at: string
    uploaded_by: number | null
    size: number | string
    username: string | null
    name: string | null
  }>
  for (const r of versions) {
    rows.push({
      kind: "version",
      at: r.uploaded_at,
      actor: { id: r.uploaded_by, username: r.username, name: r.name },
      detail: { version: r.version, size: r.size },
    })
  }

  const shares = (await db.execute({
    text: `
      SELECT s.id, s.created_at, s.expires_at, s.user_id,
             u.username, u.name
        FROM shares s
        LEFT JOIN users u ON u.id = s.user_id
       WHERE s.file_id = $1
       ORDER BY s.created_at DESC
       LIMIT 50
    `,
    values: [fileId],
  })) as Array<{
    id: number
    created_at: string
    expires_at: string | null
    user_id: number
    username: string
    name: string
  }>
  for (const r of shares) {
    rows.push({
      kind: "share",
      at: r.created_at,
      actor: { id: r.user_id, username: r.username, name: r.name },
      detail: { share_id: r.id, expires_at: r.expires_at },
    })
  }

  const collabs = (await db.execute({
    text: `
      SELECT c.id, c.created_at, c.role, c.invited_by, c.user_id, c.email,
             actor.username AS actor_username, actor.name AS actor_name,
             invitee.username AS invitee_username, invitee.name AS invitee_name
        FROM collaborations c
        LEFT JOIN users actor ON actor.id = c.invited_by
        LEFT JOIN users invitee ON invitee.id = c.user_id
       WHERE c.resource_type = 'file' AND c.resource_id = $1
       ORDER BY c.created_at DESC
       LIMIT 50
    `,
    values: [fileId],
  })) as Array<{
    id: number
    created_at: string
    role: string
    invited_by: number | null
    user_id: number | null
    email: string | null
    actor_username: string | null
    actor_name: string | null
    invitee_username: string | null
    invitee_name: string | null
  }>
  for (const r of collabs) {
    rows.push({
      kind: "collab",
      at: r.created_at,
      actor: { id: r.invited_by, username: r.actor_username, name: r.actor_name },
      detail: {
        role: r.role,
        invitee: r.user_id
          ? { id: r.user_id, username: r.invitee_username, name: r.invitee_name }
          : { id: null, email: r.email },
      },
    })
  }

  rows.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
  return rows
}

const folderActivity = async (db: Connection, folderId: number): Promise<Activity[]> => {
  const rows: Activity[] = []

  const comments = (await db.execute({
    text: `
      SELECT c.id, c.body, c.created_at, c.deleted_at, c.user_id,
             u.username, u.name
        FROM comments c
        LEFT JOIN users u ON u.id = c.user_id
       WHERE c.resource_type = 'folder' AND c.resource_id = $1
       ORDER BY c.created_at DESC
       LIMIT 100
    `,
    values: [folderId],
  })) as Array<{
    id: number
    body: string
    created_at: string
    deleted_at: string | null
    user_id: number
    username: string
    name: string
  }>
  for (const r of comments) {
    rows.push({
      kind: "comment",
      at: r.created_at,
      actor: { id: r.user_id, username: r.username, name: r.name },
      detail: { comment_id: r.id, deleted: !!r.deleted_at, body: r.deleted_at ? null : r.body },
    })
  }

  const collabs = (await db.execute({
    text: `
      SELECT c.id, c.created_at, c.role, c.invited_by, c.user_id, c.email,
             actor.username AS actor_username, actor.name AS actor_name,
             invitee.username AS invitee_username, invitee.name AS invitee_name
        FROM collaborations c
        LEFT JOIN users actor ON actor.id = c.invited_by
        LEFT JOIN users invitee ON invitee.id = c.user_id
       WHERE c.resource_type = 'folder' AND c.resource_id = $1
       ORDER BY c.created_at DESC
       LIMIT 50
    `,
    values: [folderId],
  })) as Array<{
    id: number
    created_at: string
    role: string
    invited_by: number | null
    user_id: number | null
    email: string | null
    actor_username: string | null
    actor_name: string | null
    invitee_username: string | null
    invitee_name: string | null
  }>
  for (const r of collabs) {
    rows.push({
      kind: "collab",
      at: r.created_at,
      actor: { id: r.invited_by, username: r.actor_username, name: r.actor_name },
      detail: {
        role: r.role,
        invitee: r.user_id
          ? { id: r.user_id, username: r.invitee_username, name: r.invitee_name }
          : { id: null, email: r.email },
      },
    })
  }

  rows.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
  return rows
}

export const activityRoutes = (db: Connection, secret: string) => {
  const guard = pipeline(requireAuth({ secret, db }))

  return [
    get(
      "/files/:id/activity",
      guard(async c => {
        const userId = authId(c)
        const id = Number(c.params.id)
        const access = await fileAccess(db, userId, id)
        if (!access) return json(c, 404, { error: "Not found" })
        const events = await fileActivity(db, id)
        return json(c, 200, { events })
      }),
    ),

    get(
      "/folders/:id/activity",
      guard(async c => {
        const userId = authId(c)
        const id = Number(c.params.id)
        const access = await folderAccess(db, userId, id)
        if (!access) return json(c, 404, { error: "Not found" })
        const events = await folderActivity(db, id)
        return json(c, 200, { events })
      }),
    ),
  ]
}
