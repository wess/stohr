import sharp from "sharp"
import { from } from "@atlas/db"
import type { Primitive } from "../types.ts"
import { fetchObject, makeKey, put } from "../../../storage/index.ts"

const SUPPORTED_MIMES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"])

const buildThumbName = (sourceName: string): string => {
  const dot = sourceName.lastIndexOf(".")
  const base = dot > 0 ? sourceName.slice(0, dot) : sourceName
  return `${base}-thumb.webp`
}

const transformThumbnail: Primitive = {
  kind: "transform.thumbnail",
  name: "Make a thumbnail",
  category: "transform",
  description: "Saves a small preview image alongside the original. The original is left untouched.",
  icon: "Image",
  subjects: ["file"],
  configSchema: {
    type: "object",
    required: ["width"],
    properties: {
      width: {
        type: "integer",
        minimum: 16,
        maximum: 2048,
        default: 256,
        title: "Maximum width (px)",
      },
      height: {
        type: "integer",
        minimum: 16,
        maximum: 2048,
        title: "Maximum height (px)",
        description: "Optional; defaults to keeping aspect ratio.",
      },
    },
  },
  run: async (env, config, ctx) => {
    if (env.subject.kind !== "file") return { kind: "halt", reason: "not a file" }
    const file = env.subject.row
    if (!SUPPORTED_MIMES.has(file.mime)) return { kind: "halt", reason: `unsupported mime: ${file.mime}` }

    const cfg = config as { width?: number; height?: number }
    const width = Math.max(16, Math.min(2048, Number(cfg.width ?? 256) || 256))
    const height = cfg.height && Number(cfg.height) > 0 ? Number(cfg.height) : undefined

    const obj = await fetchObject(ctx.store, file.storage_key)
    const sourceBytes = new Uint8Array(await obj.arrayBuffer())

    const outBuffer = await sharp(sourceBytes)
      .resize({ width, height, fit: "inside" })
      .webp({ quality: 80 })
      .toBuffer()
    const outBytes = new Uint8Array(outBuffer)

    const thumbName = buildThumbName(file.name)
    const thumbKey = makeKey(ctx.ownerId, thumbName)
    await put(ctx.store, thumbKey, outBytes, "image/webp")

    /* Don't overwrite an existing same-name file; insert a new files row. */
    const existing = await ctx.db.one(
      from("files")
        .where(q => q("user_id").equals(ctx.ownerId))
        .where(q => file.folder_id == null ? q("folder_id").isNull() : q("folder_id").equals(file.folder_id!))
        .where(q => q("name").equals(thumbName))
        .where(q => q("deleted_at").isNull())
        .select("id"),
    ) as { id: number } | null

    if (existing) {
      await ctx.db.execute(
        from("files").where(q => q("id").equals(existing.id)).update({
          mime: "image/webp",
          size: outBytes.byteLength,
          storage_key: thumbKey,
        }),
      )
    } else {
      await ctx.db.execute(
        from("files").insert({
          user_id: ctx.ownerId,
          folder_id: file.folder_id,
          name: thumbName,
          mime: "image/webp",
          size: outBytes.byteLength,
          storage_key: thumbKey,
          thumb_key: null,
          version: 1,
        }),
      )
    }

    /* Doesn't change the subject — the original stays as-is. */
    return { kind: "continue" }
  },
}

export default transformThumbnail
