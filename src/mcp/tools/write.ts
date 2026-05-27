import { from, raw } from "@atlas/db"
import { canWrite, fileAccess, folderAccess } from "../../permissions/index.ts"
import { drop, makeKey, put } from "../../storage/index.ts"
import { checkQuota, computeUsage } from "../../usage/index.ts"
import { asError, asText, type Tool, type ToolContext } from "./index.ts"

const archiveCurrent = async (ctx: ToolContext, file: { id: number; version: number; mime: string; size: number; storage_key: string }, uploaderId: number) => {
  await ctx.db.execute(
    from("file_versions").insert({
      file_id: file.id,
      version: file.version,
      mime: file.mime,
      size: file.size,
      storage_key: file.storage_key,
      uploaded_by: uploaderId,
    }),
  )
}

const createFolder = async (ctx: ToolContext, args: Record<string, unknown>) => {
  const name = typeof args.name === "string" ? args.name.trim() : ""
  if (!name) return asError("name is required")
  const parentRaw = args.parent_id ?? args.parentId
  const parentId = parentRaw === null || parentRaw === undefined ? null : Number(parentRaw)
  if (parentId !== null) {
    const access = await folderAccess(ctx.db, ctx.userId, parentId)
    if (!access) return asError("Parent folder not found or no access")
    if (!canWrite(access.role)) return asError("Read-only access to parent folder")
  }
  const rows = await ctx.db.execute(
    from("folders").insert({ user_id: ctx.userId, parent_id: parentId, name }).returning("id", "name", "parent_id", "created_at"),
  ) as Array<{ id: number; name: string; parent_id: number | null; created_at: string }>
  return asText(rows[0])
}

const writeFile = async (ctx: ToolContext, args: Record<string, unknown>) => {
  const name = typeof args.name === "string" ? args.name.trim() : ""
  if (!name) return asError("name is required")
  const folderRaw = args.folder_id ?? args.folderId
  const folderId = folderRaw === null || folderRaw === undefined ? null : Number(folderRaw)
  const mime = typeof args.mime === "string" && args.mime ? args.mime : "application/octet-stream"
  const encoding = (typeof args.encoding === "string" ? args.encoding : "utf-8").toLowerCase()
  const contentArg = args.content
  if (typeof contentArg !== "string") return asError("content (string) is required")

  let bytes: Uint8Array
  if (encoding === "base64") {
    bytes = new Uint8Array(Buffer.from(contentArg, "base64"))
  } else if (encoding === "utf-8" || encoding === "utf8") {
    bytes = new TextEncoder().encode(contentArg)
  } else {
    return asError("encoding must be 'utf-8' or 'base64'")
  }

  let ownerId = ctx.userId
  if (folderId !== null) {
    const access = await folderAccess(ctx.db, ctx.userId, folderId)
    if (!access) return asError("Folder not found or no access")
    if (!canWrite(access.role)) return asError("Read-only access to folder")
    ownerId = access.folder.user_id
  }

  const owner = await ctx.db.one(
    from("users").where(q => q("id").equals(ownerId)).select("storage_quota_bytes"),
  ) as { storage_quota_bytes: number | string } | null
  const quota = Number(owner?.storage_quota_bytes ?? 0)
  const incoming = bytes.byteLength
  const check = await checkQuota(ctx.db, ownerId, quota, incoming)
  if (!check.ok) {
    return asError(`Storage quota exceeded (quota=${check.quota_bytes}, used=${check.used_bytes}, attempted=${check.attempted_bytes})`)
  }

  const key = makeKey(ownerId, name)
  // Blob's TS type wants a concrete ArrayBuffer for the inner buffer; convert
  // through Uint8Array<ArrayBuffer> to satisfy it on all targets.
  const buf = new Uint8Array(new ArrayBuffer(bytes.byteLength))
  buf.set(bytes)
  const blob = new Blob([buf], { type: mime })
  await put(ctx.store, key, blob, mime)

  const existing = folderId === null
    ? await ctx.db.one(
        from("files")
          .where(q => q("user_id").equals(ownerId))
          .where(q => q("folder_id").isNull())
          .where(q => q("name").equals(name))
          .where(q => q("deleted_at").isNull()),
      ) as { id: number; version: number; mime: string; size: number; storage_key: string; thumb_key: string | null } | null
    : await ctx.db.one(
        from("files")
          .where(q => q("user_id").equals(ownerId))
          .where(q => q("folder_id").equals(folderId))
          .where(q => q("name").equals(name))
          .where(q => q("deleted_at").isNull()),
      ) as { id: number; version: number; mime: string; size: number; storage_key: string; thumb_key: string | null } | null

  let fileId: number
  let isNew: boolean
  if (existing) {
    await archiveCurrent(ctx, existing, ctx.userId)
    const newVersion = existing.version + 1
    await ctx.db.execute(
      from("files")
        .where(q => q("id").equals(existing.id))
        .update({ mime, size: incoming, storage_key: key, thumb_key: null, version: newVersion }),
    )
    if (existing.thumb_key) await Promise.allSettled([drop(ctx.store, existing.thumb_key)])
    fileId = existing.id
    isNew = false
  } else {
    const rows = await ctx.db.execute(
      from("files")
        .insert({ user_id: ownerId, folder_id: folderId, name, mime, size: incoming, storage_key: key, thumb_key: null, version: 1 })
        .returning("id"),
    ) as Array<{ id: number }>
    fileId = rows[0]!.id
    isNew = true
  }

  if (quota > 0) {
    const finalUsage = await computeUsage(ctx.db, ownerId)
    if (finalUsage.total > quota) {
      await ctx.db.execute(from("files").where(q => q("id").equals(fileId)).del())
      await Promise.allSettled([drop(ctx.store, key)])
      return asError("Storage quota exceeded after upload — change rolled back")
    }
  }

  const fresh = await ctx.db.one(
    from("files").where(q => q("id").equals(fileId)).select("id", "name", "mime", "size", "folder_id", "version", "created_at"),
  )
  return asText({ ...(fresh as object), new_version: !isNew })
}

const renameFile = async (ctx: ToolContext, args: Record<string, unknown>) => {
  const id = Number(args.id ?? args.file_id ?? args.fileId)
  const name = typeof args.name === "string" ? args.name.trim() : ""
  if (!Number.isFinite(id) || !name) return asError("id and name are required")
  const access = await fileAccess(ctx.db, ctx.userId, id)
  if (!access) return asError("File not found")
  if (!canWrite(access.role)) return asError("Read-only access")
  await ctx.db.execute(from("files").where(q => q("id").equals(id)).update({ name }))
  return asText({ id, name })
}

const moveFile = async (ctx: ToolContext, args: Record<string, unknown>) => {
  const id = Number(args.id ?? args.file_id ?? args.fileId)
  const folderRaw = args.folder_id ?? args.folderId
  if (!Number.isFinite(id)) return asError("id is required")
  if (folderRaw === undefined) return asError("folder_id is required (null for root)")
  const folderId = folderRaw === null ? null : Number(folderRaw)
  const access = await fileAccess(ctx.db, ctx.userId, id)
  if (!access) return asError("File not found")
  if (!canWrite(access.role)) return asError("Read-only access")
  if (folderId !== null) {
    const target = await folderAccess(ctx.db, ctx.userId, folderId)
    if (!target) return asError("Target folder not found")
    if (!canWrite(target.role)) return asError("No write access on target folder")
    if (target.folder.user_id !== access.file.user_id) return asError("Cannot move file across owners")
  } else if (access.role !== "owner") {
    return asError("Only the owner can move a file to the root")
  }
  await ctx.db.execute(from("files").where(q => q("id").equals(id)).update({ folder_id: folderId }))
  return asText({ id, folder_id: folderId })
}

const renameFolder = async (ctx: ToolContext, args: Record<string, unknown>) => {
  const id = Number(args.id ?? args.folder_id ?? args.folderId)
  const name = typeof args.name === "string" ? args.name.trim() : ""
  if (!Number.isFinite(id) || !name) return asError("id and name are required")
  const access = await folderAccess(ctx.db, ctx.userId, id)
  if (!access) return asError("Folder not found")
  if (!canWrite(access.role)) return asError("Read-only access")
  await ctx.db.execute(from("folders").where(q => q("id").equals(id)).update({ name }))
  return asText({ id, name })
}

const moveFolder = async (ctx: ToolContext, args: Record<string, unknown>) => {
  const id = Number(args.id ?? args.folder_id ?? args.folderId)
  const parentRaw = args.parent_id ?? args.parentId
  if (!Number.isFinite(id)) return asError("id is required")
  if (parentRaw === undefined) return asError("parent_id is required (null for root)")
  const parentId = parentRaw === null ? null : Number(parentRaw)
  if (parentId === id) return asError("A folder cannot be its own parent")
  const access = await folderAccess(ctx.db, ctx.userId, id)
  if (!access || access.role !== "owner") return asError("Only the owner can move a folder")
  if (parentId !== null) {
    const target = await folderAccess(ctx.db, ctx.userId, parentId)
    if (!target || target.role !== "owner") return asError("Target parent folder not found or not owned")
    if (target.folder.user_id !== access.folder.user_id) return asError("Cannot move folder across owners")
  }
  await ctx.db.execute(from("folders").where(q => q("id").equals(id)).update({ parent_id: parentId }))
  return asText({ id, parent_id: parentId })
}

export const writeTools = (): Tool[] => [
  {
    name: "create_folder",
    description: "Create a folder. Pass parent_id (or omit for root). The caller must have write access to the parent.",
    category: "write",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Folder name." },
        parent_id: { type: ["integer", "null"], description: "Parent folder id. Omit or null for root." },
      },
      required: ["name"],
    },
    handler: createFolder,
  },
  {
    name: "write_file",
    description: "Create or overwrite a file. Existing files with the same name in the same folder become a new version; the previous version is archived. content is UTF-8 by default, or base64 if encoding='base64'.",
    category: "write",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Filename." },
        folder_id: { type: ["integer", "null"], description: "Destination folder. Omit or null for root." },
        content: { type: "string", description: "File contents (UTF-8 or base64)." },
        encoding: { type: "string", enum: ["utf-8", "base64"], description: "Encoding of `content`. Default utf-8." },
        mime: { type: "string", description: "MIME type. Defaults to application/octet-stream." },
      },
      required: ["name", "content"],
    },
    handler: writeFile,
  },
  {
    name: "rename_file",
    description: "Rename a file.",
    category: "write",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "integer" },
        name: { type: "string" },
      },
      required: ["id", "name"],
    },
    handler: renameFile,
  },
  {
    name: "move_file",
    description: "Move a file to another folder (or root with folder_id=null). Cannot cross owners.",
    category: "write",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "integer" },
        folder_id: { type: ["integer", "null"] },
      },
      required: ["id", "folder_id"],
    },
    handler: moveFile,
  },
  {
    name: "rename_folder",
    description: "Rename a folder.",
    category: "write",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "integer" },
        name: { type: "string" },
      },
      required: ["id", "name"],
    },
    handler: renameFolder,
  },
  {
    name: "move_folder",
    description: "Move a folder under a new parent (or root with parent_id=null). Owner-only.",
    category: "write",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "integer" },
        parent_id: { type: ["integer", "null"] },
      },
      required: ["id", "parent_id"],
    },
    handler: moveFolder,
  },
]
