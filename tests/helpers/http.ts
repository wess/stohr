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
import { waitlistRoutes } from "../../src/waitlist/index.ts"
import { adminRoutes } from "../../src/admin/index.ts"
import { paymentsRoutes } from "../../src/payments/index.ts"
import { s3KeyRoutes } from "../../src/s3keys/index.ts"
import { appRoutes } from "../../src/apps/index.ts"
import { oauthClientRoutes } from "../../src/oauth/clients.ts"
import { oauthAuthorizeRoutes } from "../../src/oauth/authorize.ts"
import { oauthTokenRoutes, oauthRevokeRoutes } from "../../src/oauth/token.ts"
import { oauthDiscoveryRoutes } from "../../src/oauth/discovery.ts"
import { deviceAuthorizeRoutes } from "../../src/oauth/device.ts"
import type { StorageHandle } from "../../src/storage/index.ts"
import type { Emailer, EmailMessage } from "../../src/email/index.ts"

export const fakeStore: StorageHandle = {
  endpoint: "http://localhost",
  bucket: "test",
  region: "us-east-1",
  accessKey: "x",
  secretKey: "x",
} as unknown as StorageHandle

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
    ...waitlistRoutes(db),
    ...adminRoutes(db, secret, fakeEmailer, TEST_APP_URL),
    ...paymentsRoutes(db, secret),
    ...s3KeyRoutes(db, secret),
    ...appRoutes(db, secret),
    ...oauthClientRoutes(db, secret),
    ...oauthAuthorizeRoutes(db, secret),
    ...oauthTokenRoutes(db, secret),
    ...oauthRevokeRoutes(db),
    ...oauthDiscoveryRoutes(),
    ...deviceAuthorizeRoutes(db, secret),
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
