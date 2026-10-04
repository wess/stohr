import type { Connection } from "@atlas/db"
import { from, raw } from "@atlas/db"

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

// Teams are a hard boundary: a row whose owner is in another team does not
// exist for the caller, whatever grants or memberships say. Every access
// resolver below carries this predicate so a guessed id from another tenant
// gets the same not-found as a nonexistent one. One subselect pair; no extra
// round-trip on the hot paths.
const ownerInCallerTeamSql = (table: "files" | "folders", userId: number) =>
  raw(`(SELECT team_id FROM users WHERE id = ${table}.user_id) = (SELECT team_id FROM users WHERE id = $1)`, userId)

// the same rule for a space: its team is its owner's team
const SPACE_IN_CALLER_TEAM = `(SELECT team_id FROM users WHERE id = s.owner_id) = (SELECT team_id FROM users WHERE id = $2)`

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
      JOIN spaces s ON s.id = m.space_id AND s.deleted_at IS NULL
      WHERE m.space_id = $1 AND m.user_id = $2
        AND ${SPACE_IN_CALLER_TEAM}
      LIMIT 1
    `,
    values: [spaceId, userId],
  })) as { role: Role } | null
  return row?.role ?? null
}

// Where-fragments for the listing surfaces (search, name lookup) that used to
// filter on user_id alone. A space folder's user_id is whoever created it, so
// that filter kept handing the creator the space's content after they were
// demoted or removed. Personal rows: owned by the caller and outside any
// space. Space rows: the caller is a current member of a live space.
// Collaborations are not included — these surfaces never showed shared
// content. Each $N is consumed in text order by the builder's renumbering.
// The space clause also pins the space to the caller's team, so a stray
// cross-team membership row can never surface another tenant's rows.
export const visibleFileSql = (userId: number) =>
  raw(
    `(
      (files.user_id = $1 AND NOT EXISTS (
        SELECT 1 FROM folders fo WHERE fo.id = files.folder_id AND fo.space_id IS NOT NULL))
      OR EXISTS (
        SELECT 1 FROM folders fo
        JOIN space_members sm ON sm.space_id = fo.space_id AND sm.user_id = $2
        JOIN spaces s ON s.id = fo.space_id AND s.deleted_at IS NULL
        WHERE fo.id = files.folder_id
          AND (SELECT team_id FROM users WHERE id = s.owner_id) = (SELECT team_id FROM users WHERE id = $3))
    )`,
    userId,
    userId,
    userId,
  )

export const visibleFolderSql = (userId: number) =>
  raw(
    `(
      (folders.user_id = $1 AND folders.space_id IS NULL)
      OR EXISTS (
        SELECT 1 FROM space_members sm
        JOIN spaces s ON s.id = sm.space_id AND s.deleted_at IS NULL
        WHERE sm.space_id = folders.space_id AND sm.user_id = $2
          AND (SELECT team_id FROM users WHERE id = s.owner_id) = (SELECT team_id FROM users WHERE id = $3))
    )`,
    userId,
    userId,
    userId,
  )

// "Mine and not in a space" — for the surfaces that are strictly personal
// (trash, WebDAV, the S3 gateway) and must never see space rows at all.
export const personalFileSql = (userId: number) =>
  raw(
    `(files.user_id = $1 AND NOT EXISTS (
      SELECT 1 FROM folders fo WHERE fo.id = files.folder_id AND fo.space_id IS NOT NULL))`,
    userId,
  )

export const folderAccess = async (
  db: Connection,
  userId: number,
  folderId: number,
): Promise<{ role: Role; folder: FolderRow } | null> => {
  const folder = (await db.one(
    from("folders")
      .where(q => q("id").equals(folderId))
      .where(q => q("deleted_at").isNull())
      .where(q => q.raw(ownerInCallerTeamSql("folders", userId))),
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
): Promise<{ role: Role; file: FileRow; spaceId: number | null } | null> => {
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
         AND (SELECT team_id FROM users WHERE id = f.user_id) = (SELECT team_id FROM users WHERE id = $2)
       LIMIT 1
    `,
    values: [fileId, userId],
  })) as (FileRow & { parent_space_id: number | null }) | null
  if (!row) return null
  const { parent_space_id: parentSpaceId, ...file } = row as FileRow & { parent_space_id: number | null }

  // If the file lives inside a Space, the space membership is the
  // authoritative source of access. We don't fall back to file.user_id
  // because in a Space "the user who uploaded it" is not the same as
  // "the file's owner" — the space is.
  if (parentSpaceId != null) {
    const role = await spaceRoleForFolder(db, userId, parentSpaceId)
    if (role) return { role, file, spaceId: parentSpaceId }
    return null
  }

  if (file.user_id === userId) return { role: "owner", file, spaceId: null }

  const direct = await fileCollab(db, userId, fileId)
  if (direct) return { role: direct.role, file, spaceId: null }

  if (file.folder_id != null) {
    const inherited = await inheritedFolderRole(db, userId, file.folder_id)
    if (inherited) return { role: inherited, file, spaceId: null }
  }
  return null
}

// Trash is not a collaboration surface: a personal row answers only to its
// owner, a space row to the space membership. Rows come back regardless of
// deleted_at so restore and purge can act on them.
export const trashedFolderAccess = async (
  db: Connection,
  userId: number,
  folderId: number,
): Promise<{ role: Role; folder: FolderRow } | null> => {
  const folder = (await db.one(
    from("folders")
      .where(q => q("id").equals(folderId))
      .where(q => q.raw(ownerInCallerTeamSql("folders", userId))),
  )) as FolderRow | null
  if (!folder) return null
  if (folder.space_id != null) {
    const role = await spaceRoleForFolder(db, userId, folder.space_id)
    return role ? { role, folder } : null
  }
  return folder.user_id === userId ? { role: "owner", folder } : null
}

export const trashedFileAccess = async (
  db: Connection,
  userId: number,
  fileId: number,
): Promise<{ role: Role; file: FileRow } | null> => {
  const row = (await db.one({
    text: `
      SELECT f.*, fo.space_id AS parent_space_id
        FROM files f
        LEFT JOIN folders fo ON fo.id = f.folder_id
       WHERE f.id = $1
         AND (SELECT team_id FROM users WHERE id = f.user_id) = (SELECT team_id FROM users WHERE id = $2)
       LIMIT 1
    `,
    values: [fileId, userId],
  })) as (FileRow & { parent_space_id: number | null }) | null
  if (!row) return null
  const { parent_space_id: parentSpaceId, ...file } = row
  if (parentSpaceId != null) {
    const role = await spaceRoleForFolder(db, userId, parentSpaceId)
    return role ? { role, file } : null
  }
  return file.user_id === userId ? { role: "owner", file } : null
}
