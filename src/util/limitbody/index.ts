import type { Conn, PipeFn } from "@atlas/server"
import { halt } from "@atlas/server"

// caps a request body before parseJson/parseForm buffer it. content-length
// is checked first so an honest oversize request is refused without reading
// a byte; chunked or lying clients are cut off once the cap is crossed. the
// accepted bytes are handed on as a fresh Request because the original
// stream has been consumed by then.

export const DEFAULT_BODY_LIMIT = 1024 * 1024

const tooLarge = (conn: Conn, max: number) => halt(conn, 413, { error: `Request body exceeds ${max} bytes` })

const readCapped = async (body: ReadableStream<Uint8Array>, max: number): Promise<Uint8Array | null> => {
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let seen = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    seen += value.byteLength
    if (seen > max) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  const out = new Uint8Array(seen)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}

export const limitBody =
  (maxBytes: number = DEFAULT_BODY_LIMIT): PipeFn =>
  async conn => {
    const declared = conn.headers.get("content-length")
    if (declared !== null) {
      const n = Number(declared)
      if (!Number.isInteger(n) || n < 0) return halt(conn, 400, { error: "Invalid content-length" })
      if (n > maxBytes) return tooLarge(conn, maxBytes)
    }
    const body = conn.request.body
    if (!body) return conn
    const bytes = await readCapped(body, maxBytes)
    if (!bytes) return tooLarge(conn, maxBytes)
    const headers = new Headers(conn.headers)
    // the rebuilt request computes its own framing
    headers.delete("content-length")
    headers.delete("transfer-encoding")
    const request = new Request(conn.request.url, {
      method: conn.method,
      headers,
      body: bytes.byteLength > 0 ? (bytes.buffer as ArrayBuffer) : undefined,
    })
    // outer layers stash things on the request object itself (the socket
    // peer from withSecurityHeaders, the team from withTeams); a Request's
    // own enumerable keys are exactly those expandos, so carry them over or
    // clientIp() and teamFor() see a bare request from here on
    Object.assign(request, conn.request)
    return { ...conn, request, body: conn.body === conn.request ? request : conn.body }
  }
