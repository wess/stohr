import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"

// WebDAV requests come in as URL paths like /webdav/photos/2024/IMG_1234.jpg.
// We resolve this to a tree-walked folder ID + optional file row by
// looking up each segment by name (case-sensitive, since the underlying
// schema is case-sensitive) under the user's owned folders.

export type ResolvedFolder = { kind: "folder"; folderId: number | null; name: string }
export type ResolvedFile = { kind: "file"; folderId: number | null; fileId: number; name: string; storage_key: string; mime: string; size: number }
export type Resolved = ResolvedFolder | ResolvedFile

export const decodeSegments = (path: string): string[] => {
  const stripped = path.replace(/^\/+/, "").replace(/\/+$/, "")
  if (stripped === "") return []
  return stripped.split("/").map(s => decodeURIComponent(s))
}

const findFolderByName = async (db: Connection, userId: number, parentId: number | null, name: string) =>
  await db.one(
    from("folders")
      .where(q => q("user_id").equals(userId))
      .where(q => q("deleted_at").isNull())
      .where(q => parentId == null ? q("parent_id").isNull() : q("parent_id").equals(parentId))
      .where(q => q("name").equals(name))
      .select("id"),
  ) as { id: number } | null

const findFileByName = async (db: Connection, userId: number, folderId: number | null, name: string) =>
  await db.one(
    from("files")
      .where(q => q("user_id").equals(userId))
      .where(q => q("deleted_at").isNull())
      .where(q => folderId == null ? q("folder_id").isNull() : q("folder_id").equals(folderId))
      .where(q => q("name").equals(name))
      .select("id", "name", "storage_key", "mime", "size"),
  ) as { id: number; name: string; storage_key: string; mime: string; size: number } | null

// Resolves a WebDAV path to either a folder (existing or missing) or a
// file. If `requireExisting` is false, returns the parent folder + name
// when the leaf doesn't exist (so PUT/MKCOL can act on the parent).
export const resolvePath = async (
  db: Connection,
  userId: number,
  segments: string[],
): Promise<{ exists: boolean; folderId: number | null; parentId: number | null; leafName: string | null; file: ResolvedFile | null }> => {
  if (segments.length === 0) {
    return { exists: true, folderId: null, parentId: null, leafName: null, file: null }
  }
  let parentId: number | null = null
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]!
    const folder = await findFolderByName(db, userId, parentId, seg)
    if (!folder) {
      return { exists: false, folderId: null, parentId, leafName: seg, file: null }
    }
    parentId = folder.id
  }
  const leaf = segments[segments.length - 1]!
  const asFile = await findFileByName(db, userId, parentId, leaf)
  if (asFile) {
    return {
      exists: true,
      folderId: parentId,
      parentId,
      leafName: leaf,
      file: { kind: "file", folderId: parentId, fileId: asFile.id, name: asFile.name, storage_key: asFile.storage_key, mime: asFile.mime, size: Number(asFile.size) },
    }
  }
  const asFolder = await findFolderByName(db, userId, parentId, leaf)
  if (asFolder) {
    return { exists: true, folderId: asFolder.id, parentId, leafName: leaf, file: null }
  }
  return { exists: false, folderId: null, parentId, leafName: leaf, file: null }
}

// Lists immediate children (folders + files) of a folder. folderId === null
// means root.
export const listChildren = async (
  db: Connection,
  userId: number,
  folderId: number | null,
): Promise<Array<{ kind: "folder" | "file"; name: string; size: number; mime: string; storage_key: string; created_at: string; id: number }>> => {
  const folders = await db.all(
    from("folders")
      .where(q => q("user_id").equals(userId))
      .where(q => q("deleted_at").isNull())
      .where(q => folderId == null ? q("parent_id").isNull() : q("parent_id").equals(folderId))
      .select("id", "name", "created_at")
      .orderBy("name", "ASC"),
  ) as Array<{ id: number; name: string; created_at: string }>

  const files = await db.all(
    from("files")
      .where(q => q("user_id").equals(userId))
      .where(q => q("deleted_at").isNull())
      .where(q => folderId == null ? q("folder_id").isNull() : q("folder_id").equals(folderId))
      .select("id", "name", "mime", "size", "storage_key", "created_at")
      .orderBy("name", "ASC"),
  ) as Array<{ id: number; name: string; mime: string; size: number | string; storage_key: string; created_at: string }>

  return [
    ...folders.map(f => ({ kind: "folder" as const, name: f.name, size: 0, mime: "httpd/unix-directory", storage_key: "", created_at: f.created_at, id: f.id })),
    ...files.map(f => ({ kind: "file" as const, name: f.name, size: Number(f.size), mime: f.mime, storage_key: f.storage_key, created_at: f.created_at, id: f.id })),
  ]
}
