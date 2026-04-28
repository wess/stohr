import type { Connection } from "@atlas/db"
import { from, raw } from "@atlas/db"
import { del, get, head, put, putHeader, setStatus, stream, text } from "@atlas/server"
import {
  computeSignature,
  constantTimeEquals,
  parseAuthHeader,
  sha256OfBytes,
} from "./sigv4.ts"
import { drop, fetchObject, makeKey, put as putStorage } from "../storage/index.ts"
import type { StorageHandle } from "../storage/index.ts"
import { normalizeUsername } from "../util/username.ts"
import { checkQuota } from "../payments/usage.ts"

type S3Owner = {
  id: number
  username: string
  storage_quota_bytes: number | string
}

const xmlConn = (c: any, status: number, body: string) =>
  text(putHeader(c, "content-type", "application/xml"), status, body)

const errXml = (c: any, code: string, message: string, status: number, requestId = "stohr") =>
  xmlConn(
    c,
    status,
    `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${code}</Code><Message>${message}</Message><RequestId>${requestId}</RequestId></Error>\n`,
  )

type ErrConn = ReturnType<typeof xmlConn>

const escapeXml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

const headersFromRequest = (req: Request): Record<string, string> => {
  const out: Record<string, string> = {}
  req.headers.forEach((v, k) => { out[k.toLowerCase()] = v })
  return out
}

const verifyAndAuthorize = async (
  db: Connection,
  c: any,
  expectedBucket: string,
  body?: Uint8Array,
): Promise<{ owner: S3Owner } | { fail: ErrConn }> => {
  const headers = headersFromRequest(c.request as Request)
  const auth = headers.authorization
  if (!auth) return { fail: errXml(c, "AccessDenied", "Missing Authorization", 403) }
  const sig = parseAuthHeader(auth)
  if (!sig) return { fail: errXml(c, "InvalidArgument", "Malformed Authorization", 400) }

  const keyRow = await db.one(
    from("s3_access_keys").where(q => q("access_key").equals(sig.accessKey)),
  ) as { id: number; user_id: number; secret_key: string } | null
  if (!keyRow) return { fail: errXml(c, "InvalidAccessKeyId", "Unknown access key", 403) }

  const owner = await db.one(
    from("users")
      .where(q => q("id").equals(keyRow.user_id))
      .select("id", "username", "storage_quota_bytes"),
  ) as S3Owner | null
  if (!owner) return { fail: errXml(c, "InvalidAccessKeyId", "User not found", 403) }

  const expectedUsername = normalizeUsername(expectedBucket)
  if (owner.username !== expectedUsername) {
    return { fail: errXml(c, "AccessDenied", "Bucket does not belong to this access key", 403) }
  }

  const url = new URL((c.request as Request).url)
  const declaredHash = headers["x-amz-content-sha256"] ?? "UNSIGNED-PAYLOAD"
  let payloadHash = declaredHash
  if (declaredHash !== "UNSIGNED-PAYLOAD" && body) {
    const computed = sha256OfBytes(body)
    if (declaredHash !== computed && declaredHash !== "STREAMING-AWS4-HMAC-SHA256-PAYLOAD") {
      return { fail: errXml(c, "XAmzContentSHA256Mismatch", "Body hash mismatch", 400) }
    }
    payloadHash = computed
  }

  const amzDate = headers["x-amz-date"] ?? ""
  if (!amzDate) return { fail: errXml(c, "InvalidArgument", "Missing x-amz-date", 400) }

  const expected = computeSignature({
    method: c.request.method,
    path: url.pathname,
    query: url.search,
    headers,
    payloadHash,
    secretKey: keyRow.secret_key,
    sig,
    amzDate,
  })

  if (!constantTimeEquals(expected, sig.signature)) {
    return { fail: errXml(c, "SignatureDoesNotMatch", "The request signature did not match", 403) }
  }

  await db.execute(
    from("s3_access_keys").where(q => q("id").equals(keyRow.id)).update({ last_used_at: raw("NOW()") }),
  )

  return { owner }
}

const splitKeyPath = (key: string): { folderPath: string[]; fileName: string } => {
  const parts = key.split("/").filter(p => p.length > 0)
  if (parts.length === 0) return { folderPath: [], fileName: "" }
  const fileName = parts.pop()!
  return { folderPath: parts, fileName }
}

const ensureFolderPath = async (
  db: Connection,
  ownerId: number,
  segments: string[],
): Promise<number | null> => {
  let parentId: number | null = null
  for (const segment of segments) {
    const existing = await db.one(
      from("folders")
        .where(q => q("user_id").equals(ownerId))
        .where(q => parentId == null ? q("parent_id").isNull() : q("parent_id").equals(parentId))
        .where(q => q("name").equals(segment))
        .where(q => q("deleted_at").isNull())
        .select("id"),
    ) as { id: number } | null
    if (existing) {
      parentId = existing.id
      continue
    }
    const inserted = await db.execute(
      from("folders")
        .insert({ user_id: ownerId, parent_id: parentId, name: segment })
        .returning("id"),
    ) as Array<{ id: number }>
    parentId = inserted[0]!.id
  }
  return parentId
}

const findFolderByPath = async (
  db: Connection,
  ownerId: number,
  segments: string[],
): Promise<number | null | "missing"> => {
  if (segments.length === 0) return null
  let parentId: number | null = null
  for (const segment of segments) {
    const existing = await db.one(
      from("folders")
        .where(q => q("user_id").equals(ownerId))
        .where(q => parentId == null ? q("parent_id").isNull() : q("parent_id").equals(parentId))
        .where(q => q("name").equals(segment))
        .where(q => q("deleted_at").isNull())
        .select("id"),
    ) as { id: number } | null
    if (!existing) return "missing"
    parentId = existing.id
  }
  return parentId
}

const findFile = async (
  db: Connection,
  ownerId: number,
  folderId: number | null,
  fileName: string,
) => {
  return await db.one(
    from("files")
      .where(q => q("user_id").equals(ownerId))
      .where(q => folderId == null ? q("folder_id").isNull() : q("folder_id").equals(folderId))
      .where(q => q("name").equals(fileName))
      .where(q => q("deleted_at").isNull()),
  ) as {
    id: number
    name: string
    mime: string
    size: number
    storage_key: string
    thumb_key: string | null
    version: number
    created_at: string
  } | null
}

const keyFromUrl = (urlPath: string, bucket: string): string => {
  const prefix = `/s3/${bucket}/`
  if (urlPath.startsWith(prefix)) return decodeURIComponent(urlPath.slice(prefix.length))
  return ""
}

const emptyConn = (c: any, status: number) => setStatus(c, status)

export const s3Routes = (db: Connection, store: StorageHandle) => [
  put("/s3/:bucket/*", async (c: any) => {
    const bodyArrayBuffer = await c.request.arrayBuffer()
    const body = new Uint8Array(bodyArrayBuffer)
    const auth = await verifyAndAuthorize(db, c, c.params.bucket, body)
    if ("fail" in auth) return auth.fail
    const owner = auth.owner

    const url = new URL((c.request as Request).url)
    const objectKey = keyFromUrl(url.pathname, c.params.bucket)
    if (!objectKey) return errXml(c, "InvalidArgument", "Missing key", 400)
    const { folderPath, fileName } = splitKeyPath(objectKey)
    if (!fileName) return errXml(c, "InvalidArgument", "Object key cannot end with a slash", 400)

    const quota = Number(owner.storage_quota_bytes)
    const quotaCheck = await checkQuota(db, owner.id, quota, body.byteLength)
    if (!quotaCheck.ok) {
      return errXml(c, "EntityTooLarge", `Storage quota exceeded (${quotaCheck.used_bytes + body.byteLength} > ${quotaCheck.quota_bytes})`, 413)
    }

    const folderId = await ensureFolderPath(db, owner.id, folderPath)

    const mime = c.request.headers.get("content-type") ?? "application/octet-stream"
    const storageKey = makeKey(owner.id, fileName)
    await putStorage(store, storageKey, new Blob([body as BlobPart], { type: mime }), mime)

    const existing = await findFile(db, owner.id, folderId, fileName)
    if (existing) {
      const oldKey = existing.storage_key
      await db.execute(
        from("file_versions").insert({
          file_id: existing.id,
          version: existing.version,
          mime: existing.mime,
          size: existing.size,
          storage_key: oldKey,
          uploaded_by: owner.id,
        }),
      )
      await db.execute(
        from("files")
          .where(q => q("id").equals(existing.id))
          .update({
            mime,
            size: body.byteLength,
            storage_key: storageKey,
            thumb_key: null,
            version: existing.version + 1,
          }),
      )
    } else {
      await db.execute(
        from("files").insert({
          user_id: owner.id,
          folder_id: folderId,
          name: fileName,
          mime,
          size: body.byteLength,
          storage_key: storageKey,
          thumb_key: null,
          version: 1,
        }),
      )
    }

    const etag = `"${sha256OfBytes(body).slice(0, 32)}"`
    return setStatus(putHeader(c, "etag", etag), 200)
  }),

  get("/s3/:bucket/*", async (c: any) => {
    const auth = await verifyAndAuthorize(db, c, c.params.bucket)
    if ("fail" in auth) return auth.fail
    const owner = auth.owner
    const url = new URL((c.request as Request).url)
    const objectKey = keyFromUrl(url.pathname, c.params.bucket)

    if (!objectKey) {
      return await listBucket(c, db, owner, url.searchParams)
    }

    const { folderPath, fileName } = splitKeyPath(objectKey)
    const folderId = await findFolderByPath(db, owner.id, folderPath)
    if (folderId === "missing") return errXml(c, "NoSuchKey", "Object not found", 404)
    const file = await findFile(db, owner.id, folderId, fileName)
    if (!file) return errXml(c, "NoSuchKey", "Object not found", 404)

    const res = await fetchObject(store, file.storage_key)
    if (!res.body) return errXml(c, "InternalError", "Storage returned empty body", 500)

    const withHeaders = putHeader(
      putHeader(
        putHeader(c, "content-type", file.mime),
        "content-length",
        String(file.size),
      ),
      "last-modified",
      new Date(file.created_at).toUTCString(),
    )
    return stream(withHeaders, 200, res.body)
  }),

  head("/s3/:bucket/*", async (c: any) => {
    const auth = await verifyAndAuthorize(db, c, c.params.bucket)
    if ("fail" in auth) return auth.fail
    const owner = auth.owner
    const url = new URL((c.request as Request).url)
    const objectKey = keyFromUrl(url.pathname, c.params.bucket)
    if (!objectKey) return emptyConn(c, 200)

    const { folderPath, fileName } = splitKeyPath(objectKey)
    const folderId = await findFolderByPath(db, owner.id, folderPath)
    if (folderId === "missing") return emptyConn(c, 404)
    const file = await findFile(db, owner.id, folderId, fileName)
    if (!file) return emptyConn(c, 404)

    const headed = putHeader(
      putHeader(
        putHeader(c, "content-type", file.mime),
        "content-length",
        String(file.size),
      ),
      "last-modified",
      new Date(file.created_at).toUTCString(),
    )
    return setStatus(headed, 200)
  }),

  del("/s3/:bucket/*", async (c: any) => {
    const auth = await verifyAndAuthorize(db, c, c.params.bucket)
    if ("fail" in auth) return auth.fail
    const owner = auth.owner
    const url = new URL((c.request as Request).url)
    const objectKey = keyFromUrl(url.pathname, c.params.bucket)
    if (!objectKey) return errXml(c, "InvalidArgument", "Missing key", 400)

    const { folderPath, fileName } = splitKeyPath(objectKey)
    const folderId = await findFolderByPath(db, owner.id, folderPath)
    if (folderId === "missing") return emptyConn(c, 204)
    const file = await findFile(db, owner.id, folderId, fileName)
    if (!file) return emptyConn(c, 204)

    await db.execute(from("files").where(q => q("id").equals(file.id)).del())
    await drop(store, file.storage_key).catch(() => {})

    return emptyConn(c, 204)
  }),
]

const listBucket = async (
  c: any,
  db: Connection,
  owner: S3Owner,
  params: URLSearchParams,
) => {
  const prefix = params.get("prefix") ?? ""
  const maxKeys = Math.min(1000, Number(params.get("max-keys") ?? "1000") || 1000)

  const allFiles = await db.all(
    from("files")
      .where(q => q("user_id").equals(owner.id))
      .where(q => q("deleted_at").isNull())
      .select("id", "name", "mime", "size", "folder_id", "created_at")
      .orderBy("id", "ASC"),
  ) as Array<{ id: number; name: string; mime: string; size: number; folder_id: number | null; created_at: string }>

  const folders = await db.all(
    from("folders")
      .where(q => q("user_id").equals(owner.id))
      .where(q => q("deleted_at").isNull())
      .select("id", "parent_id", "name"),
  ) as Array<{ id: number; parent_id: number | null; name: string }>

  const folderById = new Map(folders.map(f => [f.id, f]))
  const pathFor = (folderId: number | null): string[] => {
    const parts: string[] = []
    let cur: number | null = folderId
    while (cur != null) {
      const f = folderById.get(cur)
      if (!f) break
      parts.unshift(f.name)
      cur = f.parent_id
    }
    return parts
  }

  const items = allFiles
    .map(f => ({
      key: [...pathFor(f.folder_id), f.name].join("/"),
      size: f.size,
      lastModified: f.created_at,
      mime: f.mime,
    }))
    .filter(item => item.key.startsWith(prefix))
    .slice(0, maxKeys)

  const contents = items
    .map(item => `  <Contents>
    <Key>${escapeXml(item.key)}</Key>
    <LastModified>${escapeXml(new Date(item.lastModified).toISOString())}</LastModified>
    <ETag>"${escapeXml(String(item.size))}"</ETag>
    <Size>${item.size}</Size>
    <StorageClass>STANDARD</StorageClass>
  </Contents>`)
    .join("\n")

  const xmlBody = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>${escapeXml(owner.username)}</Name>
  <Prefix>${escapeXml(prefix)}</Prefix>
  <MaxKeys>${maxKeys}</MaxKeys>
  <KeyCount>${items.length}</KeyCount>
  <IsTruncated>false</IsTruncated>
${contents}
</ListBucketResult>`

  return xmlConn(c, 200, xmlBody)
}
