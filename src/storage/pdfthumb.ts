import sharp from "sharp"
import { runProcess } from "../util/process/index.ts"
import { THUMB_MAX_BYTES, THUMB_MAX_DIM, THUMB_QUALITY } from "./thumb.ts"

const RENDER_TIMEOUT_MS = 8000

// Render the first page of a PDF to a PNG via poppler's `pdftoppm`, then
// downscale it into a webp thumbnail with the same sharp settings as the
// image thumbnailer. Returns null on any failure — missing binary, render
// error, timeout, oversized input — so the caller can fall back to a MIME
// icon without crashing.
export const generatePdfThumb = async (bytes: Uint8Array): Promise<Uint8Array | null> => {
  if (bytes.byteLength === 0) return null
  if (bytes.byteLength > THUMB_MAX_BYTES) return null

  const res = await runProcess(
    ["pdftoppm", "-png", "-singlefile", "-f", "1", "-l", "1", "-scale-to", "1024", "-", "-"],
    bytes,
    { maxBytes: 8 * 1024 * 1024, timeoutMs: RENDER_TIMEOUT_MS },
  )
  if (!res.ok) return null
  const png = res.stdout

  if (!png || png.byteLength === 0) return null

  try {
    const thumb = await sharp(png, { limitInputPixels: 16_777_216 })
      .resize({ width: THUMB_MAX_DIM, height: THUMB_MAX_DIM, fit: "inside" })
      .webp({ quality: THUMB_QUALITY })
      .toBuffer()
    return new Uint8Array(thumb)
  } catch {
    return null
  }
}
