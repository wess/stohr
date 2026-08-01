import type { ByteRange } from "../storage/index.ts"

// RFC 7233 Range parsing, narrowed to what a browser media element actually
// sends. Without this, Safari refuses to play a video at all (it opens with
// `Range: bytes=0-1` and treats a 200 as "not seekable"), and Chrome/Firefox
// can only play straight through with no scrubbing.
//
// Deliberately unsupported: multipart ranges (`bytes=0-99,200-299`). Nothing
// mainstream sends them for media, and honoring one means a multipart/byteranges
// body. A multi-range request falls back to the full object, which is a legal
// response.
export type RangeResult = { kind: "none" } | { kind: "satisfiable"; range: ByteRange } | { kind: "unsatisfiable" }

export const parseRange = (header: string | null, size: number): RangeResult => {
  if (!header) return { kind: "none" }
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return { kind: "none" }

  const [, rawStart, rawEnd] = match
  // A zero-length object has no satisfiable range at all.
  if (size <= 0) return { kind: "unsatisfiable" }

  let start: number
  let end: number
  if (rawStart === "") {
    // Suffix form: `bytes=-500` means the last 500 bytes.
    const suffix = Number(rawEnd)
    if (!Number.isFinite(suffix) || suffix <= 0) return { kind: "unsatisfiable" }
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(rawStart)
    if (!Number.isFinite(start)) return { kind: "none" }
    if (start >= size) return { kind: "unsatisfiable" }
    end = rawEnd === "" ? size - 1 : Number(rawEnd)
    if (!Number.isFinite(end)) return { kind: "none" }
    // An end past the last byte is clamped rather than rejected, per spec.
    end = Math.min(end, size - 1)
  }

  if (end < start) return { kind: "unsatisfiable" }
  return { kind: "satisfiable", range: { start, end } }
}
