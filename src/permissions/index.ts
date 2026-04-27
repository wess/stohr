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
  deleted_at: string | null
  created_at: string
}

export const canWrite = (role: Role) => role === "owner" || role === "editor"
export const isOwner = (role: Role) => role === "owner"

const folderCollab = async (db: Connection, userId: number, folderId: number) =>
  await db.one(
    from("collaborations")
      .where(q => q("resource_type").equals("folder"))
      .where(q => q("resource_id").equals(folderId))
      .where(q => q("user_id").equals(userId))
      .select("role"),
  ) as { role: Role } | null

const fileCollab = async (db: Connection, userId: number, fileId: number) =>
  await db.one(
    from("collaborations")
      .where(q => q("resource_type").equals("file"))
      .where(q => q("resource_id").equals(fileId))
      .where(q => q("user_id").equals(userId))
      .select("role"),
  ) as { role: Role } | null

const inheritedFolderRole = async (
  db: Connection,
  userId: number,
  startFolderId: number,
): Promise<Role | null> => {
  let id: number | null = startFolderId
  const seen = new Set<number>()
  while (id != null && !seen.has(id)) {
    seen.add(id)
    const direct = await folderCollab(db, userId, id)
    if (direct) return direct.role
    const parent = await db.one(
      from("folders")
        .where(q => q("id").equals(id))
        .select("parent_id"),
    ) as { parent_id: number | null } | null
    id = parent?.parent_id ?? null
  }
  return null
}

export const folderAccess = async (
  db: Connection,
  userId: number,
  folderId: number,
): Promise<{ role: Role; folder: FolderRow } | null> => {
  const folder = await db.one(
    from("folders")
      .where(q => q("id").equals(folderId))
      .where(q => q("deleted_at").isNull()),
  ) as FolderRow | null
  if (!folder) return null

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
  const file = await db.one(
    from("files")
      .where(q => q("id").equals(fileId))
      .where(q => q("deleted_at").isNull()),
  ) as FileRow | null
  if (!file) return null

  if (file.user_id === userId) return { role: "owner", file }

  const direct = await fileCollab(db, userId, fileId)
  if (direct) return { role: direct.role, file }

  if (file.folder_id != null) {
    const inherited = await inheritedFolderRole(db, userId, file.folder_id)
    if (inherited) return { role: inherited, file }
  }
  return null
}
