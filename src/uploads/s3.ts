// S3 multipart upload calls, signed with the SAME AWS SigV4 path the storage
// driver uses (atlas/packages/storage/signing). We deliberately do NOT pull in
// @aws-sdk — the signer here is the exact one @atlas/storage uses for its own
// PUT/GET/DELETE operations.
//
// The opaque StorageHandle the rest of the app passes around exposes only
// put/get/drop, so it can't drive multipart. We rebuild the S3 store config
// from the same env vars src/server.ts reads to construct the driver, then
// sign raw requests against it.
import { signRequest } from "atlas/packages/storage/signing/index.ts"

export type S3Store = {
  endpoint: string
  bucket: string
  region: string
  accessKey: string
  secretKey: string
}

// True when the running instance is backed by the S3 driver. Local-disk
// installs never touch any of this module.
export const isS3 = (): boolean => (process.env.STORAGE_DRIVER ?? "s3") !== "local"

export const s3Store = (): S3Store => ({
  endpoint: (process.env.S3_ENDPOINT ?? "http://localhost:4000").replace(/\/+$/, ""),
  bucket: process.env.S3_BUCKET ?? "stohr",
  region: process.env.S3_REGION ?? "us-east-1",
  accessKey: process.env.S3_ACCESS_KEY ?? "rustfsadmin",
  secretKey: process.env.S3_SECRET_KEY ?? "rustfsadmin",
})

const objectUrl = (store: S3Store, key: string): URL => new URL(`/${store.bucket}/${key}`, store.endpoint)

const send = async (
  store: S3Store,
  method: string,
  url: URL,
  body?: Uint8Array | string | null,
  extraHeaders?: Record<string, string>,
): Promise<Response> => {
  const headers = new Headers({ host: url.host, ...(extraHeaders ?? {}) })
  const signed = signRequest({
    method,
    url,
    headers,
    body: body ?? null,
    accessKey: store.accessKey,
    secretKey: store.secretKey,
    region: store.region,
    service: "s3",
  })
  headers.set("authorization", signed.authorization)
  return fetch(url.toString(), {
    method,
    headers,
    body: body as unknown as RequestInit["body"],
  })
}

const xmlValue = (xml: string, tag: string): string | null => {
  const m = new RegExp(`<${tag}>(.*?)</${tag}>`).exec(xml)
  return m ? m[1]! : null
}

const escapeXml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

// InitiateMultipartUpload -> returns the S3 upload id used by every later part.
export const initiateMultipart = async (store: S3Store, key: string, contentType?: string): Promise<string> => {
  const url = objectUrl(store, key)
  url.searchParams.set("uploads", "")
  const res = await send(store, "POST", url, "", contentType ? { "content-type": contentType } : undefined)
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`S3 InitiateMultipartUpload failed for '${key}': HTTP ${res.status}. ${text}`)
  }
  const xml = await res.text()
  const uploadId = xmlValue(xml, "UploadId")
  if (!uploadId) throw new Error(`S3 InitiateMultipartUpload returned no UploadId for '${key}'`)
  return uploadId
}

// UploadPart -> part numbers are 1-based. Returns the ETag S3 hands back,
// which CompleteMultipartUpload must echo for every part.
export const uploadPart = async (
  store: S3Store,
  key: string,
  uploadId: string,
  partNumber: number,
  body: Uint8Array,
): Promise<string> => {
  const url = objectUrl(store, key)
  url.searchParams.set("partNumber", String(partNumber))
  url.searchParams.set("uploadId", uploadId)
  const res = await send(store, "PUT", url, body)
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`S3 UploadPart ${partNumber} failed for '${key}': HTTP ${res.status}. ${text}`)
  }
  const etag = res.headers.get("etag")
  if (!etag) throw new Error(`S3 UploadPart ${partNumber} returned no ETag for '${key}'`)
  return etag
}

export type PartEtag = { part: number; etag: string }

// CompleteMultipartUpload -> assembles the parts into the final object. Parts
// must be ordered ascending by part number in the request body.
export const completeMultipart = async (
  store: S3Store,
  key: string,
  uploadId: string,
  parts: PartEtag[],
): Promise<void> => {
  const url = objectUrl(store, key)
  url.searchParams.set("uploadId", uploadId)
  const ordered = [...parts].sort((a, b) => a.part - b.part)
  const body = `<CompleteMultipartUpload>${ordered
    .map(p => `<Part><PartNumber>${p.part}</PartNumber><ETag>${escapeXml(p.etag)}</ETag></Part>`)
    .join("")}</CompleteMultipartUpload>`
  const res = await send(store, "POST", url, body, { "content-type": "application/xml" })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`S3 CompleteMultipartUpload failed for '${key}': HTTP ${res.status}. ${text}`)
  }
  // S3 can return a 200 with an error body — surface that as a failure too.
  const text = await res.text()
  if (text.includes("<Error>")) {
    throw new Error(`S3 CompleteMultipartUpload errored for '${key}': ${text}`)
  }
}

// AbortMultipartUpload -> releases the staged parts. Tolerates 404 the same
// way the driver's remove() does, so cleanup is idempotent.
export const abortMultipart = async (store: S3Store, key: string, uploadId: string): Promise<void> => {
  const url = objectUrl(store, key)
  url.searchParams.set("uploadId", uploadId)
  const res = await send(store, "DELETE", url)
  if (!res.ok && res.status !== 404) {
    const text = await res.text()
    throw new Error(`S3 AbortMultipartUpload failed for '${key}': HTTP ${res.status}. ${text}`)
  }
}
