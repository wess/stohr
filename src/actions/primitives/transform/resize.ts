import { from } from "@atlas/db"
import sharp from "sharp"
import { clamdConfig } from "../../../scanning/index.ts"
import { drop, fetchObject, makeKey, put } from "../../../storage/index.ts"
import { generateImageThumb, isThumbable, thumbKeyFor } from "../../../storage/thumb.ts"
import { checkActionQuota, finishActionWrite } from "../../quota.ts"
import type { Primitive } from "../types.ts"

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

// the schema advertises these bounds but nothing enforced them at run time,
// so a hand-edited config could ask sharp for a gigapixel canvas
const MAX_DIM = 8192

const clampDim = (v: unknown): number | undefined => {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return undefined
  return Math.min(MAX_DIM, Math.round(n))
}

const clampQuality = (v: unknown): number => {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return 85
  return Math.max(1, Math.min(100, Math.round(n)))
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
    const widthAbs = clampDim(cfg.width)
    const widthPct = Number(cfg.width_pct ?? 0)
    const hasPct = Number.isFinite(widthPct) && widthPct > 0 && widthPct <= 100
    if (widthAbs === undefined && !hasPct) {
      return { kind: "fail", error: "width (px) or width_pct (1-100) is required" }
    }
    const height = clampDim(cfg.height)
    const fit = cfg.fit ?? "inside"
    const format = cfg.format
    const quality = clampQuality(cfg.quality)

    const obj = await fetchObject(ctx.store, file.storage_key)
    const sourceBytes = new Uint8Array(await obj.arrayBuffer())

    let targetWidth: number
    if (widthAbs !== undefined) {
      targetWidth = widthAbs
    } else {
      const meta = await sharp(sourceBytes, { limitInputPixels: 40_000_000 }).metadata()
      if (!meta.width || meta.width <= 0) {
        return { kind: "fail", error: "couldn't determine source image width" }
      }
      targetWidth = Math.min(MAX_DIM, Math.max(1, Math.round((meta.width * widthPct) / 100)))
    }

    let pipeline = sharp(sourceBytes, { limitInputPixels: 40_000_000 }).resize({ width: targetWidth, height, fit })
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
    const quota = await checkActionQuota(ctx.db, ctx.ownerId, outBytes.byteLength)
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
        scan_status: file.scan_status,
        scan_signature: file.scan_signature,
        scanned_at: file.scanned_at,
      }),
    )
    const oldThumb = file.thumb_key
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
          scan_status: clamdConfig() ? "pending" : "skipped",
          scan_signature: null,
          scanned_at: null,
        }),
    )
    await finishActionWrite(ctx.db, ctx.store, ctx.ownerId, quota, outBytes.byteLength, newKey, file, newThumbKey)
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
            scan_status: clamdConfig() ? "pending" : "skipped",
            scan_signature: null,
            scanned_at: null,
          },
        },
      },
    }
  },
}

export default transformResize
