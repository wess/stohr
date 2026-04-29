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

const transformResize: Primitive = {
  kind: "transform.resize",
  name: "Resize image",
  category: "transform",
  description: "Shrinks an image to a maximum width while keeping its proportions.",
  icon: "Image",
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
  run: async (env, config, ctx) => {
    if (env.subject.kind !== "file") return { kind: "halt", reason: "not a file" }
    const file = env.subject.row
    if (!SUPPORTED_MIMES.has(file.mime)) {
      return { kind: "halt", reason: `unsupported mime: ${file.mime}` }
    }

    const cfg = config as {
      width?: number
      width_pct?: number
      height?: number
      fit?: "contain" | "cover" | "fill" | "inside" | "outside"
      format?: "webp" | "jpeg" | "png"
      quality?: number
    }
    const widthAbs = Number(cfg.width ?? 0)
    const widthPct = Number(cfg.width_pct ?? 0)
    const hasAbs = Number.isFinite(widthAbs) && widthAbs > 0
    const hasPct = Number.isFinite(widthPct) && widthPct > 0 && widthPct <= 100
    if (!hasAbs && !hasPct) {
      return { kind: "fail", error: "width (px) or width_pct (1-100) is required" }
    }
    const height = cfg.height && Number(cfg.height) > 0 ? Number(cfg.height) : undefined
    const fit = cfg.fit ?? "inside"
    const format = cfg.format
    const quality = cfg.quality && Number(cfg.quality) > 0 ? Math.min(100, Number(cfg.quality)) : 85

    const obj = await fetchObject(ctx.store, file.storage_key)
    const sourceBytes = new Uint8Array(await obj.arrayBuffer())

    let targetWidth: number
    if (hasAbs) {
      targetWidth = widthAbs
    } else {
      const meta = await sharp(sourceBytes).metadata()
      if (!meta.width || meta.width <= 0) {
        return { kind: "fail", error: "couldn't determine source image width" }
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

export default transformResize
