import { from } from "@atlas/db"
import { fetchObject } from "../../storage/index.ts"
import { fileAccess, folderAccess } from "../../permissions/index.ts"
import { asError, asText, type Tool, type ToolContext } from "./index.ts"

// Cap raw-content responses so a single read_file call can't pull a multi-GB
// blob into the JSON-RPC response. 1 MiB is generous for prompts.
const MAX_INLINE_BYTES = 1024 * 1024

const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64")

const listFolders = async (ctx: ToolContext, args: Record<string, unknown>) => {
  const parentRaw = args.parent_id ?? args.parentId
  const parentId = parentRaw === null || parentRaw === undefined ? null : Number(parentRaw)
  const rows = await ctx.db.all(
    from("folders")
      .where(q => q("user_id").equals(ctx.userId))
      .where(q => q("deleted_at").isNull())
      .where(q => parentId === null ? q("parent_id").isNull() : q("parent_id").equals(parentId))
      .select("id", "name", "parent_id", "created_at")
      .orderBy("name", "ASC"),
  )
  return asText(rows)
}

const listFiles = async (ctx: ToolContext, args: Record<string, unknown>) => {
  const folderRaw = args.folder_id ?? args.folderId
  const folderId = folderRaw === null || folderRaw === undefined ? null : Number(folderRaw)
  if (folderId !== null) {
    const access = await folderAccess(ctx.db, ctx.userId, folderId)
    if (!access) return asError("Folder not found or no access")
  }
  const rows = await ctx.db.all(
    from("files")
      .where(q => q("user_id").equals(ctx.userId))
      .where(q => q("deleted_at").isNull())
      .where(q => folderId === null ? q("folder_id").isNull() : q("folder_id").equals(folderId))
      .select("id", "name", "mime", "size", "folder_id", "version", "created_at")
      .orderBy("name", "ASC"),
  )
  return asText(rows)
}

const readFile = async (ctx: ToolContext, args: Record<string, unknown>) => {
  const id = Number(args.id ?? args.file_id ?? args.fileId)
  if (!Number.isFinite(id)) return asError("id is required")
  const maxBytes = Math.min(MAX_INLINE_BYTES, Number(args.max_bytes ?? args.maxBytes ?? MAX_INLINE_BYTES))
  const access = await fileAccess(ctx.db, ctx.userId, id)
  if (!access) return asError("File not found or no access")
  if (access.file.size > maxBytes) {
    return asText({
      id: access.file.id,
      name: access.file.name,
      mime: access.file.mime,
      size: access.file.size,
      truncated: true,
      note: `File is ${access.file.size} bytes — larger than max_bytes (${maxBytes}). Increase max_bytes or download via the HTTP API.`,
    })
  }
  const blob = await fetchObject(ctx.store, access.file.storage_key)
  if (!blob) return asError("Storage miss")
  const bytes = new Uint8Array(await blob.arrayBuffer())
  // Heuristic: serve text/* as raw UTF-8 so models don't need to base64-decode.
  const isText = access.file.mime.startsWith("text/")
    || access.file.mime === "application/json"
    || access.file.mime === "application/xml"
  if (isText) {
    return asText({
      id: access.file.id,
      name: access.file.name,
      mime: access.file.mime,
      size: access.file.size,
      content: new TextDecoder().decode(bytes),
      encoding: "utf-8",
    })
  }
  return asText({
    id: access.file.id,
    name: access.file.name,
    mime: access.file.mime,
    size: access.file.size,
    content: toBase64(bytes),
    encoding: "base64",
  })
}

const search = async (ctx: ToolContext, args: Record<string, unknown>) => {
  const q = typeof args.query === "string" ? args.query.trim() : ""
  if (!q) return asError("query is required")
  const files = await ctx.db.all(
    from("files")
      .where(p => p("user_id").equals(ctx.userId))
      .where(p => p("deleted_at").isNull())
      .where(p => p("name").ilike(`%${q}%`))
      .select("id", "name", "mime", "size", "folder_id", "version", "created_at")
      .orderBy("created_at", "DESC")
      .limit(50),
  )
  const folders = await ctx.db.all(
    from("folders")
      .where(p => p("user_id").equals(ctx.userId))
      .where(p => p("deleted_at").isNull())
      .where(p => p("name").ilike(`%${q}%`))
      .select("id", "name", "parent_id", "created_at")
      .orderBy("created_at", "DESC")
      .limit(50),
  )
  return asText({ files, folders })
}

export const readTools = (): Tool[] => [
  {
    name: "list_folders",
    description: "List folders under a parent (or the root when parent_id is omitted).",
    category: "read",
    inputSchema: {
      type: "object",
      properties: {
        parent_id: { type: ["integer", "null"], description: "Folder id whose children to list. Omit or null for root." },
      },
    },
    handler: listFolders,
  },
  {
    name: "list_files",
    description: "List files in a folder (or the root when folder_id is omitted).",
    category: "read",
    inputSchema: {
      type: "object",
      properties: {
        folder_id: { type: ["integer", "null"], description: "Folder id whose files to list. Omit or null for root." },
      },
    },
    handler: listFiles,
  },
  {
    name: "read_file",
    description: "Read a file's bytes. Returns UTF-8 for text/* and JSON/XML; base64 otherwise. Caps at max_bytes (default 1 MiB).",
    category: "read",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "integer", description: "File id" },
        max_bytes: { type: "integer", description: "Upper bound on returned bytes (default and ceiling: 1048576)." },
      },
      required: ["id"],
    },
    handler: readFile,
  },
  {
    name: "search",
    description: "Case-insensitive substring search across the caller's file and folder names. Limited to 50 of each.",
    category: "read",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Substring to match against names." },
      },
      required: ["query"],
    },
    handler: search,
  },
]
