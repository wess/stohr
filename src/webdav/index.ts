import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import type { Conn, PipeFn, Route } from "@atlas/server"
import { halt, pipeline, putHeader, setStatus, stream, text } from "@atlas/server"
import { dropFederationBlob, fetchFederationBytes, isFederationKey } from "../federation/files.ts"
import { requireSettingEnabledBasic, SETTING_WEBDAV_ENABLED, webdavEnabled } from "../settings/index.ts"
import type { StorageHandle } from "../storage/index.ts"
import { drop, fetchObject, makeKey, put } from "../storage/index.ts"
import { authenticateWebdav } from "./auth.ts"
import { decodeSegments, listChildren, resolvePath } from "./paths.ts"
import type { PropfindEntry } from "./xml.ts"
import { renderLockResponse, renderMultistatus } from "./xml.ts"

const WEBDAV_PREFIX = "/webdav"

// Custom helpers for WebDAV verbs not in the standard router exports.
// Accept any PipeFn so the standard pipeline() wrappers slot in directly.
const webdavRoute = (method: string, pattern: string, handler: PipeFn): Route => ({
  method,
  pattern,
  handler,
})

// WebDAV speaks HTTP Basic, not Bearer. The username is the account email and
// the password is a Personal Access Token (stohr_pat_…); authenticateWebdav
// verifies it against the apps table with the same hashing requireAuth uses.
const requireBasic =
  (db: Connection) =>
  async (conn: Conn): Promise<Conn> => {
    const auth = await authenticateWebdav(db, conn.request.headers.get("authorization"))
    if (!auth) {
      return halt(putHeader(conn, "www-authenticate", 'Basic realm="Stohr WebDAV"'), 401, { error: "Unauthorized" })
    }
    return { ...conn, assigns: { ...conn.assigns, webdav_user: auth } }
  }

const webdavUser = (c: Conn): { userId: number; email: string; username: string } => (c.assigns as any).webdav_user

const pathFromConn = (c: Conn): string[] => {
  const url = new URL(c.request.url)
  const path = url.pathname.startsWith(WEBDAV_PREFIX) ? url.pathname.slice(WEBDAV_PREFIX.length) : url.pathname
  return decodeSegments(path)
}

const hrefFor = (segments: string[], isCollection: boolean): string => {
  const base = `${WEBDAV_PREFIX}/${segments.map(encodeURIComponent).join("/")}`
  if (isCollection && !base.endsWith("/")) return `${base}/`
  return base
}

const collectSubtreeFolderIds = async (db: Connection, rootId: number): Promise<number[]> => {
  const rows = (await db.execute({
    text: `
      WITH RECURSIVE sub AS (
        SELECT id FROM folders WHERE id = $1
        UNION ALL
        SELECT f.id FROM folders f JOIN sub s ON f.parent_id = s.id
      )
      SELECT id FROM sub
    `,
    values: [rootId],
  })) as Array<{ id: number }>
  return rows.map(r => r.id)
}

export const webdavRoutes = (db: Connection, store: StorageHandle): Route[] => {
  const gate = requireSettingEnabledBasic(db, SETTING_WEBDAV_ENABLED)
  const dav = pipeline(gate, requireBasic(db))

  return [
    webdavRoute("OPTIONS", "/webdav/*", async conn => {
      // OPTIONS must work even without auth so clients can discover DAV
      // support before sending credentials — but it should still 503 when
      // WebDAV is disabled on this instance so clients don't probe the
      // surface looking for endpoints that won't answer.
      if (!(await webdavEnabled(db))) {
        return halt(conn, 503, { error: "webdav_enabled is disabled on this instance" })
      }
      const withHeaders = putHeader(
        putHeader(
          putHeader(conn, "dav", "1, 2"),
          "allow",
          "OPTIONS, GET, HEAD, PUT, DELETE, MKCOL, PROPFIND, COPY, MOVE, LOCK, UNLOCK",
        ),
        "ms-author-via",
        "DAV",
      )
      return setStatus(withHeaders, 200)
    }),

    webdavRoute(
      "PROPFIND",
      "/webdav/*",
      dav(async c => {
        const u = webdavUser(c)
        const segments = pathFromConn(c)
        const resolved = await resolvePath(db, u.userId, segments)
        if (!resolved.exists && !resolved.file) {
          return halt(c, 404, { error: "Not found" })
        }

        const depthHeader = (c.request.headers.get("depth") ?? "1").toLowerCase()
        const depth = depthHeader === "0" ? 0 : depthHeader === "infinity" ? Infinity : 1

        const entries: PropfindEntry[] = []
        if (resolved.file) {
          entries.push({
            href: hrefFor(segments, false),
            isCollection: false,
            name: resolved.file.name,
            size: resolved.file.size,
            mime: resolved.file.mime,
            created_at: new Date().toISOString(),
          })
        } else {
          const folderRow = resolved.folderId
            ? ((await db.one(
                from("folders")
                  .where(q => q("id").equals(resolved.folderId))
                  .select("name", "created_at"),
              )) as { name: string; created_at: string } | null)
            : null
          entries.push({
            href: hrefFor(segments, true),
            isCollection: true,
            name: folderRow?.name ?? "/",
            size: 0,
            mime: "httpd/unix-directory",
            created_at: folderRow?.created_at ?? new Date().toISOString(),
          })

          if (depth >= 1) {
            const children = await listChildren(db, u.userId, resolved.folderId)
            for (const child of children) {
              entries.push({
                href: hrefFor([...segments, child.name], child.kind === "folder"),
                isCollection: child.kind === "folder",
                name: child.name,
                size: child.size,
                mime: child.mime,
                created_at: child.created_at,
              })
            }
          }
        }

        const body = renderMultistatus(entries)
        const withHeaders = putHeader(c, "content-type", "application/xml; charset=utf-8")
        return text(withHeaders, 207, body)
      }),
    ),

    webdavRoute(
      "GET",
      "/webdav/*",
      dav(async c => {
        const u = webdavUser(c)
        const segments = pathFromConn(c)
        const resolved = await resolvePath(db, u.userId, segments)
        if (!resolved.file) return halt(c, 404, { error: "Not found" })
        const f = resolved.file

        if (isFederationKey(f.storage_key)) {
          const bytes = await fetchFederationBytes(db, store, f.storage_key)
          if (!bytes) return halt(c, 502, { error: "Federation blob unrecoverable" })
          const headered = putHeader(putHeader(c, "content-type", f.mime), "content-length", String(bytes.length))
          const rs = new ReadableStream<Uint8Array>({
            start(ctrl) {
              ctrl.enqueue(bytes)
              ctrl.close()
            },
          })
          return stream(headered, 200, rs)
        }

        const res = await fetchObject(store, f.storage_key)
        if (!res.body) return halt(c, 500, { error: "Storage returned empty body" })
        const headered = putHeader(putHeader(c, "content-type", f.mime), "content-length", String(f.size))
        return stream(headered, 200, res.body)
      }),
    ),

    webdavRoute(
      "HEAD",
      "/webdav/*",
      dav(async c => {
        const u = webdavUser(c)
        const segments = pathFromConn(c)
        const resolved = await resolvePath(db, u.userId, segments)
        if (!resolved.exists) return halt(c, 404, { error: "Not found" })
        if (resolved.file) {
          const headered = putHeader(
            putHeader(c, "content-type", resolved.file.mime),
            "content-length",
            String(resolved.file.size),
          )
          return setStatus(headered, 200)
        }
        return setStatus(c, 200)
      }),
    ),

    webdavRoute(
      "PUT",
      "/webdav/*",
      dav(async c => {
        const u = webdavUser(c)
        const segments = pathFromConn(c)
        if (segments.length === 0) return halt(c, 405, { error: "Cannot PUT root" })
        const resolved = await resolvePath(db, u.userId, segments)
        if (resolved.exists && !resolved.file) return halt(c, 409, { error: "Path is a collection" })

        const folderId = resolved.parentId
        const fileName = segments[segments.length - 1]!
        const body = await c.request.arrayBuffer()
        const bytes = new Uint8Array(body)
        const mime = c.request.headers.get("content-type") ?? "application/octet-stream"

        // Don't allow writing into federation-tied folders via this simple
        // path — that needs to go through the federation upload flow. A
        // future enhancement could detect and route through it automatically.
        if (folderId != null) {
          const parent = (await db.one(
            from("folders")
              .where(q => q("id").equals(folderId))
              .select("federation_role"),
          )) as { federation_role: string | null } | null
          if (parent?.federation_role) {
            return halt(c, 422, { error: "WebDAV writes into federation folders are not yet supported" })
          }
        }

        const key = makeKey(u.userId, fileName)
        await put(store, key, bytes, mime)

        if (resolved.file) {
          // Replace: archive the current version, update the row.
          await db.execute(
            from("file_versions").insert({
              file_id: resolved.file.fileId,
              version: 1,
              mime: resolved.file.mime,
              size: resolved.file.size,
              storage_key: resolved.file.storage_key,
              uploaded_by: u.userId,
            }),
          )
          await db.execute(
            from("files")
              .where(q => q("id").equals(resolved.file!.fileId))
              .update({
                mime,
                size: bytes.length,
                storage_key: key,
              }),
          )
          if (!isFederationKey(resolved.file.storage_key)) {
            await drop(store, resolved.file.storage_key).catch(() => {})
          }
          return setStatus(c, 204)
        } else {
          await db.execute(
            from("files").insert({
              user_id: u.userId,
              folder_id: folderId,
              name: fileName,
              mime,
              size: bytes.length,
              storage_key: key,
              version: 1,
            }),
          )
          return setStatus(c, 201)
        }
      }),
    ),

    webdavRoute(
      "DELETE",
      "/webdav/*",
      dav(async c => {
        const u = webdavUser(c)
        const segments = pathFromConn(c)
        if (segments.length === 0) return halt(c, 403, { error: "Cannot delete root" })
        const resolved = await resolvePath(db, u.userId, segments)
        if (!resolved.exists && !resolved.file) return halt(c, 404, { error: "Not found" })

        if (resolved.file) {
          const f = resolved.file
          await db.execute(
            from("files")
              .where(q => q("id").equals(f.fileId))
              .del(),
          )
          if (isFederationKey(f.storage_key)) {
            await dropFederationBlob(db, store, f.storage_key).catch(() => {})
          } else {
            await drop(store, f.storage_key).catch(() => {})
          }
          return setStatus(c, 204)
        }

        // Folder: hard-delete the whole subtree. Soft-delete would be nicer
        // but WebDAV clients don't model trash; they expect DELETE to actually
        // remove the resource.
        if (resolved.folderId == null) return halt(c, 403, { error: "Cannot delete root" })
        const ids = await collectSubtreeFolderIds(db, resolved.folderId)
        const fileRows = (await db.all(
          from("files")
            .where(q => q("folder_id").inList(ids))
            .select("id", "storage_key"),
        )) as Array<{ id: number; storage_key: string }>
        const fileIds = fileRows.map(r => r.id).concat(-1)

        await db.execute(
          from("file_versions")
            .where(q => q("file_id").inList(fileIds))
            .del(),
        )
        await db.execute(
          from("files")
            .where(q => q("folder_id").inList(ids))
            .del(),
        )
        await db.execute(
          from("folders")
            .where(q => q("id").inList(ids))
            .del(),
        )

        await Promise.allSettled(
          fileRows.map(r =>
            isFederationKey(r.storage_key) ? dropFederationBlob(db, store, r.storage_key) : drop(store, r.storage_key),
          ),
        )
        return setStatus(c, 204)
      }),
    ),

    webdavRoute(
      "MKCOL",
      "/webdav/*",
      dav(async c => {
        const u = webdavUser(c)
        const segments = pathFromConn(c)
        if (segments.length === 0) return halt(c, 405, { error: "Cannot MKCOL root" })
        const resolved = await resolvePath(db, u.userId, segments)
        if (resolved.exists) return halt(c, 405, { error: "Resource already exists" })
        if (!resolved.leafName) return halt(c, 409, { error: "Parent does not exist" })

        // RFC 4918 §9.3: MKCOL requires the parent to exist; only the leaf
        // is created.
        const parentId = resolved.parentId
        if (segments.length > 1) {
          // Re-resolve parent path (segments minus last) to confirm.
          const parentSegs = segments.slice(0, -1)
          const parentResolved = await resolvePath(db, u.userId, parentSegs)
          if (!parentResolved.exists || parentResolved.file) {
            return halt(c, 409, { error: "Parent collection does not exist" })
          }
        }
        await db.execute(
          from("folders").insert({
            user_id: u.userId,
            parent_id: parentId,
            name: resolved.leafName,
            kind: "standard",
            is_public: false,
          }),
        )
        return setStatus(c, 201)
      }),
    ),

    webdavRoute(
      "MOVE",
      "/webdav/*",
      dav(async c => {
        const u = webdavUser(c)
        const segments = pathFromConn(c)
        const destinationHeader = c.request.headers.get("destination")
        if (!destinationHeader) return halt(c, 400, { error: "Missing Destination header" })

        let destPath: string
        try {
          destPath = new URL(destinationHeader).pathname
        } catch {
          destPath = destinationHeader
        }
        if (!destPath.startsWith(WEBDAV_PREFIX)) return halt(c, 400, { error: "Destination outside WebDAV root" })
        const destSegments = decodeSegments(destPath.slice(WEBDAV_PREFIX.length))
        if (destSegments.length === 0) return halt(c, 403, { error: "Cannot move to root" })

        const src = await resolvePath(db, u.userId, segments)
        if (!src.exists && !src.file) return halt(c, 404, { error: "Source not found" })

        const dst = await resolvePath(db, u.userId, destSegments)
        const overwrite = (c.request.headers.get("overwrite") ?? "T").toUpperCase() !== "F"
        if (dst.exists && !overwrite) return halt(c, 412, { error: "Destination exists and Overwrite is F" })

        if (src.file) {
          if (dst.exists && dst.file) {
            // Overwrite — drop destination file row + bytes first.
            await db.execute(
              from("files")
                .where(q => q("id").equals(dst.file!.fileId))
                .del(),
            )
            if (isFederationKey(dst.file.storage_key))
              await dropFederationBlob(db, store, dst.file.storage_key).catch(() => {})
            else await drop(store, dst.file.storage_key).catch(() => {})
          }
          const newName = destSegments[destSegments.length - 1]!
          const newFolderId = dst.parentId
          await db.execute(
            from("files")
              .where(q => q("id").equals(src.file!.fileId))
              .update({ name: newName, folder_id: newFolderId }),
          )
          return setStatus(c, dst.exists ? 204 : 201)
        }

        // Folder move/rename. Disallow moving a folder into its own subtree.
        if (src.folderId == null) return halt(c, 403, { error: "Cannot move root" })
        const subtreeIds = await collectSubtreeFolderIds(db, src.folderId)
        if (dst.folderId != null && subtreeIds.includes(dst.folderId)) {
          return halt(c, 409, { error: "Cannot move folder into its own subtree" })
        }
        const newName = destSegments[destSegments.length - 1]!
        const newParentId = dst.parentId
        await db.execute(
          from("folders")
            .where(q => q("id").equals(src.folderId!))
            .update({ name: newName, parent_id: newParentId }),
        )
        return setStatus(c, 201)
      }),
    ),

    webdavRoute(
      "COPY",
      "/webdav/*",
      dav(async c => {
        const u = webdavUser(c)
        const segments = pathFromConn(c)
        const destinationHeader = c.request.headers.get("destination")
        if (!destinationHeader) return halt(c, 400, { error: "Missing Destination header" })
        let destPath: string
        try {
          destPath = new URL(destinationHeader).pathname
        } catch {
          destPath = destinationHeader
        }
        if (!destPath.startsWith(WEBDAV_PREFIX)) return halt(c, 400, { error: "Destination outside WebDAV root" })
        const destSegments = decodeSegments(destPath.slice(WEBDAV_PREFIX.length))
        if (destSegments.length === 0) return halt(c, 403, { error: "Cannot copy to root" })

        const src = await resolvePath(db, u.userId, segments)
        if (!src.file) return halt(c, 422, { error: "Only file COPY is supported in MVP" })

        const f = src.file
        const newName = destSegments[destSegments.length - 1]!
        const dst = await resolvePath(db, u.userId, destSegments)
        const overwrite = (c.request.headers.get("overwrite") ?? "T").toUpperCase() !== "F"
        if (dst.exists && !overwrite) return halt(c, 412, { error: "Destination exists" })

        let bytes: Uint8Array
        if (isFederationKey(f.storage_key)) {
          const b = await fetchFederationBytes(db, store, f.storage_key)
          if (!b) return halt(c, 502, { error: "Federation blob unrecoverable" })
          bytes = b
        } else {
          const res = await fetchObject(store, f.storage_key)
          bytes = new Uint8Array(await res.arrayBuffer())
        }
        const key = makeKey(u.userId, newName)
        await put(store, key, bytes, f.mime)
        await db.execute(
          from("files").insert({
            user_id: u.userId,
            folder_id: dst.parentId,
            name: newName,
            mime: f.mime,
            size: bytes.length,
            storage_key: key,
            version: 1,
          }),
        )
        return setStatus(c, dst.exists ? 204 : 201)
      }),
    ),

    // LOCK / UNLOCK are no-ops. macOS Finder refuses to write to a share that
    // doesn't answer LOCK, so we hand back a synthetic lock token without
    // actually tracking any lock state — Stohr has no multi-writer locking
    // model and single-user mounts don't need one. UNLOCK always succeeds.
    webdavRoute(
      "LOCK",
      "/webdav/*",
      dav(async c => {
        const segments = pathFromConn(c)
        const token = `opaquelocktoken:${crypto.randomUUID()}`
        const body = renderLockResponse(hrefFor(segments, false), token)
        const headered = putHeader(
          putHeader(c, "content-type", "application/xml; charset=utf-8"),
          "lock-token",
          `<${token}>`,
        )
        return text(headered, 200, body)
      }),
    ),

    webdavRoute(
      "UNLOCK",
      "/webdav/*",
      dav(async c => setStatus(c, 204)),
    ),
  ]
}
