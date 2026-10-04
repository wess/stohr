import type { App } from "./http.ts"
import { makeRequest } from "./http.ts"

// multipart/form-data caller for the upload routes. Bun's Request serializes
// a FormData body with the boundary header for us, so parseMultipart on the
// other side sees exactly what a browser would send.
export const callMultipart = async <T = any>(
  app: App,
  path: string,
  opts: {
    token: string
    fields?: Record<string, string>
    files: Array<{ field?: string; name: string; type?: string; body: string | Uint8Array }>
    host?: string
  },
): Promise<{ status: number; body: T }> => {
  const fd = new FormData()
  for (const [k, v] of Object.entries(opts.fields ?? {})) fd.append(k, v)
  for (const f of opts.files) {
    const blob = new Blob([f.body as BlobPart], { type: f.type ?? "application/octet-stream" })
    fd.append(f.field ?? "file", blob, f.name)
  }
  const req = makeRequest(path, {
    method: "POST",
    headers: { authorization: `Bearer ${opts.token}`, "x-forwarded-for": "127.0.0.1" },
    body: fd,
    host: opts.host,
  })
  const res = await app(req)
  const text = await res.text()
  let body: any = null
  if (text) {
    try { body = JSON.parse(text) } catch { body = text }
  }
  return { status: res.status, body: body as T }
}
