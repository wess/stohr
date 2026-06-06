import type { Connection } from "@atlas/db"
import { router } from "@atlas/server"
import { authRoutes } from "../../src/auth/index.ts"
import { mfaRoutes } from "../../src/auth/mfa.ts"
import { sessionRoutes } from "../../src/auth/sessions.ts"
import { passwordRoutes } from "../../src/auth/password.ts"
import { deletionRoutes } from "../../src/auth/deletion.ts"
import { userRoutes } from "../../src/users/index.ts"
import { folderRoutes } from "../../src/folders/index.ts"
import { fileRoutes } from "../../src/files/index.ts"
import { shareRoutes } from "../../src/shares/index.ts"
import { trashRoutes } from "../../src/trash/index.ts"
import { searchRoutes } from "../../src/search/index.ts"
import { inviteRoutes } from "../../src/invites/index.ts"
import { collabRoutes } from "../../src/collabs/index.ts"
import { publicRoutes } from "../../src/public/index.ts"
import { adminRoutes } from "../../src/admin/index.ts"
import { s3KeyRoutes } from "../../src/s3keys/index.ts"
import { appRoutes } from "../../src/apps/index.ts"
import { oauthClientRoutes } from "../../src/oauth/clients.ts"
import { oauthAuthorizeRoutes } from "../../src/oauth/authorize.ts"
import { oauthTokenRoutes, oauthRevokeRoutes } from "../../src/oauth/token.ts"
import { oauthDiscoveryRoutes } from "../../src/oauth/discovery.ts"
import { deviceAuthorizeRoutes } from "../../src/oauth/device.ts"
import { adminSettingsRoutes } from "../../src/settings/index.ts"
import { adminMcpRoutes, mcpRoutes } from "../../src/mcp/index.ts"
import { mcpServerRoutes } from "../../src/mcp/servers.ts"
import { commentRoutes } from "../../src/comments/index.ts"
import { notificationRoutes } from "../../src/notifications/index.ts"
import { activityRoutes } from "../../src/activity/index.ts"
import { spaceRoutes } from "../../src/spaces/index.ts"
import { messageRoutes } from "../../src/messages/index.ts"
import { photoRoutes } from "../../src/photos/index.ts"
import { oidcRoutes } from "../../src/auth/oidc/index.ts"
import { adminOidcRoutes } from "../../src/auth/oidc/admin.ts"
import { ldapRoutes } from "../../src/auth/ldap/index.ts"
import { adminLdapRoutes } from "../../src/auth/ldap/admin.ts"
import { contentSearchRoutes } from "../../src/search/content/routes.ts"
import { adminUserRoutes } from "../../src/admin/users.ts"
import { webdavRoutes } from "../../src/webdav/index.ts"
import { webdavSettingsRoutes } from "../../src/webdav/settings.ts"
import type { StorageHandle } from "../../src/storage/index.ts"
import type { Emailer, EmailMessage } from "../../src/email/index.ts"

// In-memory storage stub implementing the full StorageDriver interface
// (put / get / drop) so handlers that read objects back — e.g. share
// downloads via fetchObject -> h.get — work under test. put returns the
// stored bytes from get, mirroring the real drivers.
const fakeStoreObjects = new Map<string, { body: Uint8Array; contentType?: string }>()

const toBytes = async (body: Blob | Uint8Array | string): Promise<Uint8Array> => {
  if (typeof body === "string") return new TextEncoder().encode(body)
  if (body instanceof Uint8Array) return body
  return new Uint8Array(await body.arrayBuffer())
}

export const fakeStore: StorageHandle = {
  put: async (key, body, contentType) => {
    fakeStoreObjects.set(key, { body: await toBytes(body), contentType })
  },
  get: async (key) => {
    const obj = fakeStoreObjects.get(key)
    if (!obj) return new Response(null, { status: 404 })
    return new Response(obj.body, {
      status: 200,
      headers: obj.contentType ? { "content-type": obj.contentType } : undefined,
    })
  },
  drop: async (key) => {
    fakeStoreObjects.delete(key)
  },
}

// Captures sent emails for assertion in tests. Cleared per-test by setup
// (truncateAll doesn't touch this; tests that care should pull and reset).
export const sentEmails: EmailMessage[] = []
export const resetSentEmails = () => {
  sentEmails.length = 0
}
export const fakeEmailer: Emailer = {
  enabled: true,
  send: async (msg) => {
    sentEmails.push(msg)
    return { ok: true, id: `test-${sentEmails.length}` }
  },
}

export const TEST_APP_URL = "http://test.local"

export const buildApp = (db: Connection, secret: string) => {
  return router(
    ...authRoutes(db, secret),
    ...passwordRoutes(db, fakeEmailer, TEST_APP_URL),
    ...mfaRoutes(db, secret),
    ...sessionRoutes(db, secret),
    ...deletionRoutes(db, secret),
    ...userRoutes(db, secret, fakeStore, fakeEmailer, TEST_APP_URL),
    ...folderRoutes(db, secret, fakeStore),
    ...fileRoutes(db, secret, fakeStore),
    ...shareRoutes(db, secret, fakeStore),
    ...trashRoutes(db, secret, fakeStore),
    ...searchRoutes(db, secret),
    ...inviteRoutes(db, secret),
    ...collabRoutes(db, secret, fakeEmailer, TEST_APP_URL),
    ...publicRoutes(db, secret, fakeStore),
    ...adminRoutes(db, secret),
    ...s3KeyRoutes(db, secret),
    ...appRoutes(db, secret),
    ...oauthClientRoutes(db, secret),
    ...oauthAuthorizeRoutes(db, secret),
    ...oauthTokenRoutes(db, secret),
    ...oauthRevokeRoutes(db),
    ...oauthDiscoveryRoutes(),
    ...deviceAuthorizeRoutes(db, secret),
    ...adminSettingsRoutes(db, secret),
    ...mcpRoutes(db, secret, fakeStore, TEST_APP_URL),
    ...adminMcpRoutes(db, secret, TEST_APP_URL),
    ...mcpServerRoutes(db, secret),
    ...commentRoutes(db, secret),
    ...notificationRoutes(db, secret),
    ...activityRoutes(db, secret),
    ...spaceRoutes(db, secret),
    ...messageRoutes(db, secret),
    ...photoRoutes(db, secret, fakeStore),
    ...oidcRoutes(db, secret, TEST_APP_URL),
    ...adminOidcRoutes(db, secret),
    ...ldapRoutes(db, secret),
    ...adminLdapRoutes(db, secret),
    ...contentSearchRoutes(db, secret),
    ...adminUserRoutes(db, secret, fakeEmailer, TEST_APP_URL),
    ...webdavRoutes(db, fakeStore),
    ...webdavSettingsRoutes(db, secret),
  )
}

type Method = "GET" | "POST" | "PATCH" | "DELETE" | "PUT"

export type App = (req: Request) => Response | Promise<Response>

export type ReqOptions = {
  method?: Method
  body?: unknown
  token?: string
  headers?: Record<string, string>
  ip?: string
}

export const callJson = async <T = any>(
  app: App,
  path: string,
  opts: ReqOptions = {},
): Promise<{ status: number; body: T }> => {
  const headers: Record<string, string> = {
    "x-forwarded-for": opts.ip ?? "127.0.0.1",
    ...(opts.headers ?? {}),
  }
  if (opts.body !== undefined && !headers["content-type"]) {
    headers["content-type"] = "application/json"
  }
  if (opts.token) headers.authorization = `Bearer ${opts.token}`

  const req = new Request(`http://test.local${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  })
  const res = await app(req)
  let body: any = null
  const text = await res.text()
  if (text) {
    try { body = JSON.parse(text) } catch { body = text }
  }
  return { status: res.status, body: body as T }
}

// Raw caller for WebDAV — needs non-standard methods (PROPFIND, MKCOL, …),
// Basic auth, and access to the unparsed text body + response headers.
export type RawOptions = {
  method?: string
  body?: string | Uint8Array
  basic?: { user: string; pass: string }
  headers?: Record<string, string>
}

export const callRaw = async (
  app: App,
  path: string,
  opts: RawOptions = {},
): Promise<{ status: number; text: string; headers: Headers }> => {
  const headers: Record<string, string> = {
    "x-forwarded-for": "127.0.0.1",
    ...(opts.headers ?? {}),
  }
  if (opts.basic) {
    const encoded = Buffer.from(`${opts.basic.user}:${opts.basic.pass}`).toString("base64")
    headers.authorization = `Basic ${encoded}`
  }
  const req = new Request(`http://test.local${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body,
  })
  const res = await app(req)
  return { status: res.status, text: await res.text(), headers: res.headers }
}
