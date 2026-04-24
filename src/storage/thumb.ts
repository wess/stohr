import sharp from "sharp"

export const THUMB_MAX_BYTES = 25 * 1024 * 1024
export const THUMB_MAX_DIM = 256
export const THUMB_QUALITY = 80

const SUPPORTED = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
])

export const isThumbable = (mime: string): boolean => SUPPORTED.has(mime)

export const generateImageThumb = async (
  bytes: Uint8Array,
  mime: string,
): Promise<Uint8Array | null> => {
  if (!isThumbable(mime)) return null
  if (bytes.byteLength > THUMB_MAX_BYTES) return null
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

export const thumbKeyFor = (storageKey: string): string =>
  `thumbs/${storageKey}.webp`
