// Text extraction for embedding. v1 supports the easy mimes:
// text/*, application/json, application/xml. PDF and Office docs are
// deferred to a later pass that wires in pdftotext / tika.
//
// Embedding models cap context at ~8192 tokens (~32k chars). We
// truncate at MAX_CHARS to stay well within that, prepended by the
// filename so the vector reflects "what is this file about" even for
// short bodies.

const MAX_CHARS = 16_000

const EMBEDDABLE_PREFIXES = [
  "text/",
  "application/json",
  "application/xml",
  "application/x-yaml",
  "application/x-toml",
  "application/javascript",
  "application/typescript",
] as const

export const isEmbeddableMime = (mime: string): boolean =>
  EMBEDDABLE_PREFIXES.some(p => mime.startsWith(p))

// Returns null when the file's mime is not embeddable. For short
// non-text files the caller can still embed `name` alone if it wants —
// we don't decide that here.
export const extractText = async (
  bytes: Uint8Array,
  mime: string,
  name: string,
): Promise<string | null> => {
  if (!isEmbeddableMime(mime)) return null

  // UTF-8 decode with replacement on invalid sequences. Files that
  // happen to be Latin-1 or other encodings will partially decode —
  // good enough for retrieval, never user-displayed.
  const decoder = new TextDecoder("utf-8", { fatal: false })
  const raw = decoder.decode(bytes)

  // Light HTML/markdown cleanup — strip the most common noise so the
  // vector reflects real content. Conservative on purpose; we are not
  // a sanitizer.
  const cleaned = mime === "text/html"
    ? raw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
    : raw

  const composed = `${name}\n\n${cleaned}`
  return composed.length > MAX_CHARS ? composed.slice(0, MAX_CHARS) : composed
}

export const sha256Hex = async (input: string): Promise<string> => {
  const enc = new TextEncoder()
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(input))
  const arr = new Uint8Array(buf)
  let out = ""
  for (const b of arr) out += b.toString(16).padStart(2, "0")
  return out
}

export const excerpt = (text: string): string =>
  text.slice(0, 1024)
