import sharp from "sharp"
import { from } from "@atlas/db"
import type { Primitive } from "../types.ts"
import { drop, fetchObject, makeKey, put } from "../../../storage/index.ts"
import { generateImageThumb, isThumbable, thumbKeyFor } from "../../../storage/thumb.ts"

const SUPPORTED_MIMES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"])

const FORMAT_TO_MIME: Record<string, string> = {
  webp: "image/webp",
  jpeg: "image/jpeg",
  png: "image/png",
}

const FORMAT_TO_EXT: Record<string, string> = {
  webp: "webp",
  jpeg: "jpg",
  png: "png",
}

const swapExtension = (name: string, ext: string): string => {
  const dot = name.lastIndexOf(".")
  if (dot <= 0) return `${name}.${ext}`
  return `${name.slice(0, dot)}.${ext}`
}

const transformCompress: Primitive = {
  kind: "transform.compress",
  name: "Compress image",
  category: "transform",
  description: "Re-encodes an image at a smaller file size, without changing its dimensions.",
  icon: "Zap",
  subjects: ["file"],
  configSchema: {
    type: "object",
    properties: {
      format: {
        type: "string",
        enum: ["webp", "jpeg", "png"],
        title: "Output format",
        description: "Leave blank to keep the original format.",
      },
      quality: {
        type: "integer",
        minimum: 1,
        maximum: 100,
        default: 80,
        title: "Quality (1-100)",
        description: "Lower numbers = smaller files but more compression artifacts.",
      },
    },
  },
  run: async (env, config, ctx) => {
    if (env.subject.kind !== "file") return { kind: "halt", reason: "not a file" }
    const file = env.subject.row
    if (!SUPPORTED_MIMES.has(file.mime)) return { kind: "halt", reason: `unsupported mime: ${file.mime}` }

    const cfg = config as { format?: "webp" | "jpeg" | "png"; quality?: number }
    const quality = cfg.quality && Number(cfg.quality) > 0 ? Math.min(100, Number(cfg.quality)) : 80
    const format = cfg.format

    const obj = await fetchObject(ctx.store, file.storage_key)
    const sourceBytes = new Uint8Array(await obj.arrayBuffer())

    let pipeline = sharp(sourceBytes)
    let outMime: string
    let outExt: string

    if (format) {
      outMime = FORMAT_TO_MIME[format]!
      outExt = FORMAT_TO_EXT[format]!
      if (format === "webp") pipeline = pipeline.webp({ quality })
      else if (format === "jpeg") pipeline = pipeline.jpeg({ quality })
      else pipeline = pipeline.png()
    } else {
      outMime = file.mime === "image/gif" ? "image/png" : file.mime
      if (outMime === "image/jpeg") { outExt = "jpg"; pipeline = pipeline.jpeg({ quality }) }
      else if (outMime === "image/png") { outExt = "png"; pipeline = pipeline.png() }
      else { outMime = "image/webp"; outExt = "webp"; pipeline = pipeline.webp({ quality }) }
    }

    const outBytes = new Uint8Array(await pipeline.toBuffer())
    const newName = swapExtension(file.name, outExt)
    const newKey = makeKey(ctx.ownerId, newName)
    await put(ctx.store, newKey, outBytes, outMime)

    let newThumbKey: string | null = null
    if (isThumbable(outMime)) {
      try {
        const thumb = await generateImageThumb(outBytes, outMime)
        if (thumb) {
          newThumbKey = thumbKeyFor(newKey)
          await put(ctx.store, newThumbKey, thumb, "image/webp")
        }
      } catch { newThumbKey = null }
    }

    await ctx.db.execute(
      from("file_versions").insert({
        file_id: file.id,
        version: file.version,
        mime: file.mime,
        size: file.size,
        storage_key: file.storage_key,
        uploaded_by: ctx.actor.id,
      }),
    )
    const oldThumb = file.thumb_key
    const newVersion = file.version + 1
    await ctx.db.execute(
      from("files").where(q => q("id").equals(file.id)).update({
        name: newName,
        mime: outMime,
        size: outBytes.byteLength,
        storage_key: newKey,
        thumb_key: newThumbKey,
        version: newVersion,
      }),
    )
    if (oldThumb && oldThumb !== newThumbKey) {
      await Promise.allSettled([drop(ctx.store, oldThumb)])
    }

    return {
      kind: "continue",
      envelope: {
        ...env,
        subject: {
          kind: "file",
          row: {
            ...file,
            name: newName,
            mime: outMime,
            size: outBytes.byteLength,
            storage_key: newKey,
            thumb_key: newThumbKey,
            version: newVersion,
          },
        },
      },
    }
  },
}

export default transformCompress
