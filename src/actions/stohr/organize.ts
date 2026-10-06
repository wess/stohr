import { from } from "@atlas/db"
import { findOrCreateFolder } from "../primitives/util/folders.ts"
import type { Action } from "../types.ts"

const PAD = (n: number) => String(n).padStart(2, "0")

const formatSegments = (date: Date, pattern: string): string[] => {
  const Y = String(date.getUTCFullYear())
  const M = PAD(date.getUTCMonth() + 1)
  const D = PAD(date.getUTCDate())
  if (pattern === "YYYY/MM/DD") return [Y, M, D]
  return [Y, M]
}

const action: Action = {
  slug: "stohr/organize-by-date",
  name: "Organize by date",
  description:
    "Routes files into nested year/month subfolders based on their upload date. Folders are created on demand and reused thereafter.",
  version: "1.0.0",
  author: { name: "Stohr", url: "https://stohr.io" },
  permissions: ["file.read", "file.write", "folder.read", "folder.write"],
  events: ["file.created", "file.moved.in"],
  subjects: ["file"],
  configSchema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        enum: ["YYYY/MM", "YYYY/MM/DD"],
        default: "YYYY/MM",
        title: "Subfolder pattern",
      },
    },
  },

  run: async ctx => {
    if (ctx.subject.kind !== "file") return { ok: false, error: "Subject is not a file" }
    const file = ctx.subject.row

    const config = ctx.config as { pattern?: "YYYY/MM" | "YYYY/MM/DD" }
    const pattern = config.pattern === "YYYY/MM/DD" ? "YYYY/MM/DD" : "YYYY/MM"

    const ts = new Date(file.created_at)
    if (Number.isNaN(ts.getTime())) return { ok: false, error: "Invalid file timestamp" }

    const segments = formatSegments(ts, pattern)

    let parentId = ctx.folder.id
    for (const segment of segments) {
      parentId = await findOrCreateFolder(ctx.db, ctx.ownerId, parentId, segment)
    }

    if (file.folder_id === parentId) {
      return {
        ok: true,
        result: { skipped: true, reason: "already in target folder", path: segments.join("/") },
      }
    }

    await ctx.db.execute(
      from("files")
        .where(q => q("id").equals(file.id))
        .update({ folder_id: parentId }),
    )

    return {
      ok: true,
      result: {
        file_id: file.id,
        moved_to_folder_id: parentId,
        path: segments.join("/"),
      },
    }
  },
}

export default action
