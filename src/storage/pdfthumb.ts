import { spawn } from "bun"
import sharp from "sharp"
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

  let png: Uint8Array | null = null
  try {
    // `pdftoppm -png -singlefile -f 1 -l 1 -r 96 - -` reads the PDF from
    // stdin and writes a single PNG of the first page to stdout.
    const proc = spawn(["pdftoppm", "-png", "-singlefile", "-f", "1", "-l", "1", "-r", "96", "-", "-"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    if (proc.stdin) {
      const writer = proc.stdin as unknown as { write: (b: Uint8Array) => Promise<number>; end: () => Promise<void> }
      await writer.write(bytes)
      await writer.end()
    }
    const timer = setTimeout(() => {
      try {
        proc.kill()
      } catch {}
    }, RENDER_TIMEOUT_MS)
    const out = await new Response(proc.stdout).arrayBuffer()
    const code = await proc.exited
    clearTimeout(timer)
    if (code !== 0) return null
    png = new Uint8Array(out)
  } catch {
    return null
  }

  if (!png || png.byteLength === 0) return null

  try {
    const thumb = await sharp(png)
      .resize({ width: THUMB_MAX_DIM, height: THUMB_MAX_DIM, fit: "inside" })
      .webp({ quality: THUMB_QUALITY })
      .toBuffer()
    return new Uint8Array(thumb)
  } catch {
    return null
  }
}
