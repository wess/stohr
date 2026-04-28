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
import { createStorage } from "./storage/index.ts"
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
})

const db = connect({ driver: "postgres", url: config.databaseUrl })
const store = createStorage({
  endpoint: config.s3Endpoint,
  bucket: config.s3Bucket,
  region: config.s3Region,
  accessKey: config.s3AccessKey,
  secretKey: config.s3SecretKey,
})

await migrate.up(db, "./migrations")

const fetch = router(
  ...authRoutes(db, config.secret),
  ...mfaRoutes(db, config.secret),
  ...sessionRoutes(db, config.secret),
  ...userRoutes(db, config.secret, store),
  ...folderRoutes(db, config.secret, store),
  ...fileRoutes(db, config.secret, store),
  ...shareRoutes(db, config.secret, store),
  ...trashRoutes(db, config.secret, store),
  ...searchRoutes(db, config.secret),
  ...inviteRoutes(db, config.secret),
  ...collabRoutes(db, config.secret),
  ...publicRoutes(db, config.secret, store),
  ...waitlistRoutes(db),
  ...adminRoutes(db, config.secret),
  ...paymentsRoutes(db, config.secret),
  ...s3KeyRoutes(db, config.secret),
  ...s3Routes(db, store),
  ...appRoutes(db, config.secret),
  ...oauthClientRoutes(db, config.secret),
  ...oauthAuthorizeRoutes(db, config.secret),
  ...oauthTokenRoutes(db, config.secret),
  ...oauthRevokeRoutes(db),
  ...oauthDiscoveryRoutes(),
)

// OAuth cleanup: expired auth codes (60s TTL) every 5 min, expired refresh
// tokens (30 day TTL) every hour. Survives the lifetime of the API process.
setInterval(() => { void sweepExpiredAuthCodes(db) }, 5 * 60 * 1000)
setInterval(() => { void sweepExpiredRefreshTokens(db) }, 60 * 60 * 1000)
void sweepExpiredAuthCodes(db)
void sweepExpiredRefreshTokens(db)

if (config.secret === "dev-secret-change-me") {
  console.warn("[stohr] WARNING: running with the default SECRET. Set a strong SECRET in .env before production.")
}

Bun.serve({
  port: config.port,
  hostname: "0.0.0.0",
  fetch: withSecurityHeaders(fetch),
  maxRequestBodySize: Number.MAX_SAFE_INTEGER,
  idleTimeout: 0,
})

console.log(`[stohr] api on http://localhost:${config.port}`)
console.log(`[stohr] storage endpoint: ${config.s3Endpoint} (encryption-at-rest is the provider's responsibility — see SECURITY.md)`)
