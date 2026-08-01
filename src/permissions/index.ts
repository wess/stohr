import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"

export type Role = "owner" | "editor" | "viewer"

export type FolderRow = {
  id: number
  user_id: number
  parent_id: number | null
  name: string
  kind: string
  is_public: boolean
  federation_id: number | null
  federation_role: string | null
  federation_quota_bytes: number | string
  space_id: number | null
  deleted_at: string | null
  created_at: string
}

export type FileRow = {
  id: number
  user_id: number
  folder_id: number | null
  name: string
  mime: string
  size: number
  storage_key: string
  thumb_key: string | null
  version: number
  scan_status: string
  scan_signature: string | null
  scanned_at: string | null
  deleted_at: string | null
  created_at: string
}

export const canWrite = (role: Role) => role === "owner" || role === "editor"
export const isOwner = (role: Role) => role === "owner"

const fileCollab = async (db: Connection, userId: number, fileId: number) =>
  (await db.one(
    from("collaborations")
      .where(q => q("resource_type").equals("file"))
      .where(q => q("resource_id").equals(fileId))
      .where(q => q("user_id").equals(userId))
      .select("role"),
  )) as { role: Role } | null

// Walks the folder ancestry in a single recursive CTE and returns the role
// of the nearest collaboration grant. One round-trip regardless of depth.
const inheritedFolderRole = async (db: Connection, userId: number, startFolderId: number): Promise<Role | null> => {
  const rows = (await db.execute({
    text: `
      WITH RECURSIVE chain AS (
        SELECT id, parent_id, 0 AS depth
          FROM folders
         WHERE id = $1
        UNION ALL
        SELECT f.id, f.parent_id, c.depth + 1
          FROM folders f
          JOIN chain c ON f.id = c.parent_id
         WHERE c.depth < 64
      )
      SELECT col.role
        FROM chain c
        JOIN collaborations col
          ON col.resource_type = 'folder'
         AND col.resource_id = c.id
         AND col.user_id = $2
        ORDER BY c.depth ASC
        LIMIT 1
    `,
    values: [startFolderId, userId],
  })) as Array<{ role: Role }>
  return rows[0]?.role ?? null
}

// Resolve a Space-scoped folder: walk up the parent chain to find which
// space the folder belongs to, then look up the caller's membership.
// Single round-trip — we always need the space root anyway because folder
// ancestry is contiguous (a folder in space X cannot have a parent in
// space Y or in personal).
const spaceRoleForFolder = async (db: Connection, userId: number, spaceId: number): Promise<Role | null> => {
  const row = (await db.one({
    text: `
      SELECT
        CASE WHEN m.role = 'admin' THEN 'owner'
             WHEN m.role = 'editor' THEN 'editor'
             ELSE 'viewer'
        END AS role
      FROM space_members m
      WHERE m.space_id = $1 AND m.user_id = $2
      LIMIT 1
    `,
    values: [spaceId, userId],
  })) as { role: Role } | null
  return row?.role ?? null
}

export const folderAccess = async (
  db: Connection,
  userId: number,
  folderId: number,
): Promise<{ role: Role; folder: FolderRow } | null> => {
  const folder = (await db.one(
    from("folders")
      .where(q => q("id").equals(folderId))
      .where(q => q("deleted_at").isNull()),
  )) as FolderRow | null
  if (!folder) return null

  // Space folders use the space membership table. The folder.user_id
  // (whoever created it) is just for attribution — it does not grant
  // "owner"-level access; an admin of the Space gets that.
  if (folder.space_id != null) {
    const role = await spaceRoleForFolder(db, userId, folder.space_id)
    if (role) return { role, folder }
    return null
  }

  if (folder.user_id === userId) return { role: "owner", folder }

  const role = await inheritedFolderRole(db, userId, folderId)
  if (role) return { role, folder }
  return null
}

export const fileAccess = async (
  db: Connection,
  userId: number,
  fileId: number,
): Promise<{ role: Role; file: FileRow } | null> => {
  // The parent folder's space_id comes back with the file rather than in a
  // follow-up query. Every download and thumbnail request lands here, and the
  // space check has to happen before the owner fast path, so the second
  // round-trip was unconditional.
  const row = (await db.one({
    text: `
      SELECT f.*, fo.space_id AS parent_space_id
        FROM files f
        LEFT JOIN folders fo ON fo.id = f.folder_id
       WHERE f.id = $1
         AND f.deleted_at IS NULL
       LIMIT 1
    `,
    values: [fileId],
  })) as (FileRow & { parent_space_id: number | null }) | null
  if (!row) return null
  const { parent_space_id: parentSpaceId, ...file } = row as FileRow & { parent_space_id: number | null }

  // If the file lives inside a Space, the space membership is the
  // authoritative source of access. We don't fall back to file.user_id
  // because in a Space "the user who uploaded it" is not the same as
  // "the file's owner" — the space is.
  if (parentSpaceId != null) {
    const role = await spaceRoleForFolder(db, userId, parentSpaceId)
    if (role) return { role, file }
    return null
  }

  if (file.user_id === userId) return { role: "owner", file }

  const direct = await fileCollab(db, userId, fileId)
  if (direct) return { role: direct.role, file }

  if (file.folder_id != null) {
    const inherited = await inheritedFolderRole(db, userId, file.folder_id)
    if (inherited) return { role: inherited, file }
  }
  return null
}
