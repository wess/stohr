import { from, raw } from "@atlas/db"
import { canWrite, fileAccess, folderAccess } from "../../permissions/index.ts"
import { asError, asText, type Tool, type ToolContext } from "./index.ts"

const trashFile = async (ctx: ToolContext, args: Record<string, unknown>) => {
  const id = Number(args.id ?? args.file_id ?? args.fileId)
  if (!Number.isFinite(id)) return asError("id is required")
  const access = await fileAccess(ctx.db, ctx.userId, id)
  if (!access) return asError("File not found")
  if (!canWrite(access.role)) return asError("Read-only access")
  await ctx.db.execute(
    from("files").where(q => q("id").equals(id)).update({ deleted_at: raw("NOW()") }),
  )
  return asText({ id, deleted: true })
}

const restoreFile = async (ctx: ToolContext, args: Record<string, unknown>) => {
  const id = Number(args.id ?? args.file_id ?? args.fileId)
  if (!Number.isFinite(id)) return asError("id is required")
  const row = await ctx.db.one(
    from("files").where(q => q("id").equals(id)).where(q => q("user_id").equals(ctx.userId)),
  ) as { id: number; folder_id: number | null; deleted_at: string | null } | null
  if (!row) return asError("File not found")
  if (!row.deleted_at) return asText({ id, restored: false, note: "Already live" })
  let folderId = row.folder_id
  if (folderId !== null) {
    const folder = await ctx.db.one(
      from("folders").where(q => q("id").equals(folderId)).where(q => q("deleted_at").isNull()),
    )
    if (!folder) folderId = null  // Parent gone — restore to root
  }
  await ctx.db.execute(
    from("files").where(q => q("id").equals(id)).update({ deleted_at: null, folder_id: folderId }),
  )
  return asText({ id, restored: true, folder_id: folderId })
}

const trashFolder = async (ctx: ToolContext, args: Record<string, unknown>) => {
  const id = Number(args.id ?? args.folder_id ?? args.folderId)
  if (!Number.isFinite(id)) return asError("id is required")
  const access = await folderAccess(ctx.db, ctx.userId, id)
  if (!access || access.role !== "owner") return asError("Only the owner can trash a folder")
  await ctx.db.execute(
    from("folders").where(q => q("id").equals(id)).update({ deleted_at: raw("NOW()") }),
  )
  return asText({ id, deleted: true })
}

const restoreFolder = async (ctx: ToolContext, args: Record<string, unknown>) => {
  const id = Number(args.id ?? args.folder_id ?? args.folderId)
  if (!Number.isFinite(id)) return asError("id is required")
  const row = await ctx.db.one(
    from("folders").where(q => q("id").equals(id)).where(q => q("user_id").equals(ctx.userId)),
  ) as { id: number; parent_id: number | null; deleted_at: string | null } | null
  if (!row) return asError("Folder not found")
  if (!row.deleted_at) return asText({ id, restored: false, note: "Already live" })
  let parentId = row.parent_id
  if (parentId !== null) {
    const parent = await ctx.db.one(
      from("folders").where(q => q("id").equals(parentId)).where(q => q("deleted_at").isNull()),
    )
    if (!parent) parentId = null
  }
  await ctx.db.execute(
    from("folders").where(q => q("id").equals(id)).update({ deleted_at: null, parent_id: parentId }),
  )
  return asText({ id, restored: true, parent_id: parentId })
}

export const trashTools = (): Tool[] => [
  {
    name: "trash_file",
    description: "Soft-delete a file. It moves to trash and can be restored.",
    category: "delete",
    inputSchema: {
      type: "object",
      properties: { id: { type: "integer" } },
      required: ["id"],
    },
    handler: trashFile,
  },
  {
    name: "restore_file",
    description: "Restore a previously trashed file owned by the caller.",
    category: "delete",
    inputSchema: {
      type: "object",
      properties: { id: { type: "integer" } },
      required: ["id"],
    },
    handler: restoreFile,
  },
  {
    name: "trash_folder",
    description: "Soft-delete a folder (and its contents recursively). Owner-only.",
    category: "delete",
    inputSchema: {
      type: "object",
      properties: { id: { type: "integer" } },
      required: ["id"],
    },
    handler: trashFolder,
  },
  {
    name: "restore_folder",
    description: "Restore a previously trashed folder owned by the caller.",
    category: "delete",
    inputSchema: {
      type: "object",
      properties: { id: { type: "integer" } },
      required: ["id"],
    },
    handler: restoreFolder,
  },
]
