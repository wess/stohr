import sharp from "sharp"
import { generatePdfThumb } from "./pdfthumb.ts"

export const THUMB_MAX_BYTES = 25 * 1024 * 1024
export const THUMB_MAX_DIM = 256
export const THUMB_QUALITY = 80

const SUPPORTED = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"])
const PDF_MIME = "application/pdf"

export const isThumbable = (mime: string): boolean => SUPPORTED.has(mime) || mime === PDF_MIME

export const generateImageThumb = async (bytes: Uint8Array, mime: string): Promise<Uint8Array | null> => {
  if (!isThumbable(mime)) return null
  if (bytes.byteLength > THUMB_MAX_BYTES) return null
  if (mime === PDF_MIME) return generatePdfThumb(bytes)
  try {
    const out = await sharp(bytes)
      .resize({ width: THUMB_MAX_DIM, height: THUMB_MAX_DIM, fit: "inside" })
      .webp({ quality: THUMB_QUALITY })
      .toBuffer()
    return new Uint8Array(out)
  } catch {
    return null
  }
}

export const thumbKeyFor = (storageKey: string): string => `thumbs/${storageKey}.webp`
