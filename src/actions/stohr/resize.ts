import sharp from "sharp"
import { from } from "@atlas/db"
import type { Action } from "../types.ts"
import { drop, fetchObject, makeKey, put } from "../../storage/index.ts"
import { generateImageThumb, isThumbable, thumbKeyFor } from "../../storage/thumb.ts"

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

const resizeAction: Action = {
  slug: "stohr/resize-image",
  name: "Resize image",
  description:
    "Re-encodes images that land in this folder to a fixed size. Replaces the original in place; the previous bytes are kept as a prior version.",
  version: "1.0.0",
  author: { name: "Stohr", url: "https://stohr.io" },
  permissions: ["file.read", "file.write"],
  events: ["file.created", "file.moved.in"],
  subjects: ["file"],
  configSchema: {
    type: "object",
    properties: {
      width: { type: "integer", minimum: 1, maximum: 8192, title: "Width (px)" },
      width_pct: { type: "integer", minimum: 1, maximum: 100, title: "Width (% of original)" },
      height: { type: "integer", minimum: 1, maximum: 8192, title: "Height (px)" },
      fit: {
        type: "string",
        enum: ["contain", "cover", "fill", "inside", "outside"],
        default: "inside",
        title: "Fit",
      },
      format: {
        type: "string",
        enum: ["webp", "jpeg", "png"],
        title: "Output format (default: keep source format)",
      },
      quality: { type: "integer", minimum: 1, maximum: 100, default: 85, title: "Quality (1-100)" },
    },
  },

  run: async (ctx) => {
    if (ctx.subject.kind !== "file") return { ok: false, error: "Subject is not a file" }
    const file = ctx.subject.row

    if (!SUPPORTED_MIMES.has(file.mime)) {
      return { ok: false, error: `Unsupported mime: ${file.mime}` }
    }

    const config = ctx.config as {
      width?: number
      width_pct?: number
      height?: number
      fit?: "contain" | "cover" | "fill" | "inside" | "outside"
      format?: "webp" | "jpeg" | "png"
      quality?: number
    }
    const widthAbs = Number(config.width ?? 0)
    const widthPct = Number(config.width_pct ?? 0)
    const hasAbs = Number.isFinite(widthAbs) && widthAbs > 0
    const hasPct = Number.isFinite(widthPct) && widthPct > 0 && widthPct <= 100
    if (!hasAbs && !hasPct) {
      return { ok: false, error: "config.width (px) or config.width_pct (1–100) is required" }
    }
    const height = config.height && Number(config.height) > 0 ? Number(config.height) : undefined
    const fit = config.fit ?? "inside"
    const format = config.format
    const quality = config.quality && Number(config.quality) > 0 ? Math.min(100, Number(config.quality)) : 85

    const obj = await fetchObject(ctx.store, file.storage_key)
    const sourceBytes = new Uint8Array(await obj.arrayBuffer())

    let targetWidth: number
    if (hasAbs) {
      targetWidth = widthAbs
    } else {
      const meta = await sharp(sourceBytes).metadata()
      if (!meta.width || meta.width <= 0) {
        return { ok: false, error: "Couldn't determine source image width" }
      }
      targetWidth = Math.max(1, Math.round((meta.width * widthPct) / 100))
    }

    let pipeline = sharp(sourceBytes).resize({ width: targetWidth, height, fit })
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
      if (outMime === "image/jpeg") {
        outExt = "jpg"
        pipeline = pipeline.jpeg({ quality })
      } else if (outMime === "image/png") {
        outExt = "png"
        pipeline = pipeline.png()
      } else {
        outMime = "image/webp"
        outExt = "webp"
        pipeline = pipeline.webp({ quality })
      }
    }

    const outBuffer = await pipeline.toBuffer()
    const outBytes = new Uint8Array(outBuffer)

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
      } catch {
        newThumbKey = null
      }
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

    const oldThumbKey = file.thumb_key
    const newVersion = file.version + 1

    await ctx.db.execute(
      from("files")
        .where(q => q("id").equals(file.id))
        .update({
          name: newName,
          mime: outMime,
          size: outBytes.byteLength,
          storage_key: newKey,
          thumb_key: newThumbKey,
          version: newVersion,
        }),
    )

    if (oldThumbKey && oldThumbKey !== newThumbKey) {
      await Promise.allSettled([drop(ctx.store, oldThumbKey)])
    }

    return {
      ok: true,
      result: {
        file_id: file.id,
        new_version: newVersion,
        original_size: file.size,
        resized_size: outBytes.byteLength,
        out_mime: outMime,
        out_name: newName,
        width: targetWidth,
        height: height ?? null,
        fit,
      },
    }
  },
}

export default resizeAction
