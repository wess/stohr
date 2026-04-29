import { defineConfig, env } from "@atlas/config"
import { connect } from "@atlas/db"
import { migrate } from "@atlas/migrate"
import { router } from "@atlas/server"
import { authRoutes } from "./auth/index.ts"
import { mfaRoutes } from "./auth/mfa.ts"
import { sessionRoutes } from "./auth/sessions.ts"
import { folderRoutes } from "./folders/index.ts"
import { fileRoutes } from "./files/index.ts"
import { shareRoutes } from "./shares/index.ts"
import { trashRoutes } from "./trash/index.ts"
import { userRoutes } from "./users/index.ts"
import { searchRoutes } from "./search/index.ts"
import { inviteRoutes } from "./invites/index.ts"
import { collabRoutes } from "./collabs/index.ts"
import { publicRoutes } from "./public/index.ts"
import { waitlistRoutes } from "./waitlist/index.ts"
import { adminRoutes } from "./admin/index.ts"
import { paymentsRoutes } from "./payments/index.ts"
import { s3KeyRoutes } from "./s3keys/index.ts"
import { s3Routes } from "./s3/index.ts"
import { appRoutes } from "./apps/index.ts"
import { oauthClientRoutes } from "./oauth/clients.ts"
import { oauthAuthorizeRoutes, sweepExpiredAuthCodes } from "./oauth/authorize.ts"
import { oauthTokenRoutes, oauthRevokeRoutes, sweepExpiredRefreshTokens } from "./oauth/token.ts"
import { oauthDiscoveryRoutes } from "./oauth/discovery.ts"
import { deviceAuthorizeRoutes, sweepExpiredDeviceCodes } from "./oauth/device.ts"
import { actionRoutes } from "./actions/index.ts"
import { userActionRoutes } from "./actions/user/index.ts"
import { passwordRoutes, sweepExpiredPasswordResets } from "./auth/password.ts"
import { passkeyRoutes, sweepExpiredWebauthnChallenges } from "./auth/passkeys.ts"
import { createStorage } from "./storage/index.ts"
import { createEmailer } from "./email/index.ts"
import { withSecurityHeaders } from "./security/headers.ts"

const config = defineConfig({
  port: env("PORT", { parse: Number, default: "3000" }),
  secret: env("SECRET", { default: "dev-secret-change-me" }),
  databaseUrl: env("DATABASE_URL", { default: "postgres://postgres:postgres@localhost:5432/stohr" }),
  s3Endpoint: env("S3_ENDPOINT", { default: "http://localhost:4000" }),
  s3Bucket: env("S3_BUCKET", { default: "stohr" }),
  s3Region: env("S3_REGION", { default: "us-east-1" }),
  s3AccessKey: env("S3_ACCESS_KEY", { default: "rustfsadmin" }),
  s3SecretKey: env("S3_SECRET_KEY", { default: "rustfsadmin" }),
  appUrl: env("APP_URL", { default: "http://localhost:3001" }),
  resendApiKey: env("RESEND_API_KEY", { default: "" }),
  resendFrom: env("RESEND_FROM", { default: "Stohr <onboarding@resend.dev>" }),
  rpId: env("RP_ID", { default: "localhost" }),
  rpName: env("RP_NAME", { default: "Stohr" }),
  rpOrigin: env("RP_ORIGIN", { default: "http://localhost:3001" }),
  // @atlas/storage buffers the upload body in API memory to compute the
  // AWS SigV4 payload hash, so this cap is *also* a memory ceiling per
  // concurrent upload. Plan a future migration to presigned-PUT direct-to-S3
  // uploads (presign helper already exists in @atlas/storage) to remove the
  // buffering and raise this cap safely.
  maxUploadBytes: env("MAX_UPLOAD_BYTES", { parse: Number, default: String(1024 * 1024 * 1024) }),
})

const db = connect({ driver: "postgres", url: config.databaseUrl })
const store = createStorage({
  endpoint: config.s3Endpoint,
  bucket: config.s3Bucket,
  region: config.s3Region,
  accessKey: config.s3AccessKey,
  secretKey: config.s3SecretKey,
})
const emailer = createEmailer({
  apiKey: config.resendApiKey,
  from: config.resendFrom,
})

await migrate.up(db, "./migrations")

const fetch = router(
  ...authRoutes(db, config.secret),
  ...passwordRoutes(db, emailer, config.appUrl),
  ...mfaRoutes(db, config.secret),
  ...passkeyRoutes(db, config.secret, { rpId: config.rpId, rpName: config.rpName, rpOrigin: config.rpOrigin }),
  ...sessionRoutes(db, config.secret),
  ...userRoutes(db, config.secret, store),
  ...folderRoutes(db, config.secret, store),
  ...fileRoutes(db, config.secret, store),
  ...shareRoutes(db, config.secret, store),
  ...trashRoutes(db, config.secret, store),
  ...searchRoutes(db, config.secret),
  ...inviteRoutes(db, config.secret),
  ...collabRoutes(db, config.secret, emailer, config.appUrl),
  ...publicRoutes(db, config.secret, store),
  ...waitlistRoutes(db),
  ...adminRoutes(db, config.secret, emailer, config.appUrl),
  ...paymentsRoutes(db, config.secret),
  ...s3KeyRoutes(db, config.secret),
  ...s3Routes(db, store),
  ...appRoutes(db, config.secret),
  ...oauthClientRoutes(db, config.secret),
  ...oauthAuthorizeRoutes(db, config.secret),
  ...oauthTokenRoutes(db, config.secret),
  ...oauthRevokeRoutes(db),
  ...oauthDiscoveryRoutes(),
  ...deviceAuthorizeRoutes(db, config.secret),
  ...actionRoutes(db, config.secret),
  ...userActionRoutes(db, config.secret),
)

// OAuth cleanup: expired auth codes (60s TTL) every 5 min, expired device
// codes (10 min TTL) every 5 min, expired refresh tokens (30 day TTL) every
// hour. Survives the lifetime of the API process. Each sweep is guarded so
// a slow run cannot stack onto itself and chew through the connection pool.
const guardedSweep = (label: string, fn: () => Promise<unknown>) => {
  let running = false
  return async () => {
    if (running) return
    running = true
    try { await fn() } catch (err) { console.error(`[stohr] sweep ${label} failed:`, err) }
    finally { running = false }
  }
}
const sweepAuthCodes = guardedSweep("auth_codes", () => sweepExpiredAuthCodes(db))
const sweepDeviceCodes = guardedSweep("device_codes", () => sweepExpiredDeviceCodes(db))
const sweepRefreshTokens = guardedSweep("refresh_tokens", () => sweepExpiredRefreshTokens(db))
const sweepPasswordResets = guardedSweep("password_resets", () => sweepExpiredPasswordResets(db))
const sweepWebauthn = guardedSweep("webauthn_challenges", () => sweepExpiredWebauthnChallenges(db))
setInterval(() => { void sweepAuthCodes() }, 5 * 60 * 1000)
setInterval(() => { void sweepDeviceCodes() }, 5 * 60 * 1000)
setInterval(() => { void sweepRefreshTokens() }, 60 * 60 * 1000)
setInterval(() => { void sweepPasswordResets() }, 60 * 60 * 1000)
setInterval(() => { void sweepWebauthn() }, 5 * 60 * 1000)
void sweepAuthCodes()
void sweepDeviceCodes()
void sweepRefreshTokens()
void sweepPasswordResets()
void sweepWebauthn()

// Production refuses to start with the default SECRET — JWTs signed with a
// known value would be forgeable by anyone. In development we just warn so
// `bun run dev` works out of the box on a fresh clone.
const isDev = (process.env.NODE_ENV ?? "development") === "development"
if (config.secret === "dev-secret-change-me") {
  if (isDev) {
    console.warn("[stohr] WARNING: running with the default SECRET. Set a strong SECRET in .env before production.")
  } else {
    console.error("[stohr] FATAL: SECRET is set to its default value. Refusing to start. Set SECRET in your environment to a strong random string (e.g. `openssl rand -hex 32`).")
    process.exit(1)
  }
}
if (config.secret.length < 32 && !isDev) {
  console.error(`[stohr] FATAL: SECRET is too short (${config.secret.length} chars). Use at least 32 chars in production.`)
  process.exit(1)
}

Bun.serve({
  port: config.port,
  hostname: "0.0.0.0",
  fetch: withSecurityHeaders(fetch),
  maxRequestBodySize: config.maxUploadBytes,
  idleTimeout: 0,
})

console.log(`[stohr] api on http://localhost:${config.port}`)
console.log(`[stohr] storage endpoint: ${config.s3Endpoint} (encryption-at-rest is the provider's responsibility — see SECURITY.md)`)
