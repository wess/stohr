import { defineConfig, env } from "@atlas/config"
import { connect } from "@atlas/db"
import { migrate } from "@atlas/migrate"
import { router } from "@atlas/server"
import { authRoutes } from "./auth/index.ts"
import { mfaRoutes } from "./auth/mfa.ts"
import { sessionRoutes } from "./auth/sessions.ts"
import { oidcRoutes, sweepExpiredOidcStates } from "./auth/oidc/index.ts"
import { adminOidcRoutes } from "./auth/oidc/admin.ts"
import { ldapRoutes } from "./auth/ldap/index.ts"
import { adminLdapRoutes } from "./auth/ldap/admin.ts"
import { folderRoutes } from "./folders/index.ts"
import { fileRoutes } from "./files/index.ts"
import { shareRoutes } from "./shares/index.ts"
import { trashRoutes } from "./trash/index.ts"
import { userRoutes } from "./users/index.ts"
import { searchRoutes } from "./search/index.ts"
import { contentSearchRoutes } from "./search/content/routes.ts"
import { indexBatch as indexContentBatch } from "./search/content/indexer.ts"
import { inviteRoutes } from "./invites/index.ts"
import { collabRoutes } from "./collabs/index.ts"
import { commentRoutes } from "./comments/index.ts"
import { notificationRoutes } from "./notifications/index.ts"
import { activityRoutes } from "./activity/index.ts"
import { spaceRoutes } from "./spaces/index.ts"
import { messageRoutes } from "./messages/index.ts"
import { photoRoutes } from "./photos/index.ts"
import { publicRoutes } from "./public/index.ts"
import { adminRoutes } from "./admin/index.ts"
import { adminUserRoutes } from "./admin/users.ts"
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
import { deletionRoutes, sweepDeletedAccounts } from "./auth/deletion.ts"
import { contactRoutes } from "./contact/index.ts"
import { federationRoutes } from "./federation/index.ts"
import { pairingReceiverRoutes } from "./federation/pairing.ts"
import { sweepExpiredFederationInvites } from "./federation/invites.ts"
import { federationFolderRoutes } from "./federation/folders.ts"
import { federationFilesRoutes, sweepFederationDrains } from "./federation/files.ts"
import { webdavRoutes } from "./webdav/index.ts"
import { adminSettingsRoutes, SETTING_WEBDAV_ENABLED, seedIfMissing } from "./settings/index.ts"
import { aiRoutes } from "./ai/routes.ts"
import { adminMcpRoutes, mcpRoutes } from "./mcp/index.ts"
import { mcpServerRoutes } from "./mcp/servers.ts"
import { castleRoutes } from "./castle/index.ts"
import { setupStohrSso } from "./sso/index.ts"

// Wire @atlas/sso only when all three OIDC env vars are supplied. Returns
// an empty list otherwise so the router signature doesn't care.
const maybeSsoRoutes = async (db: any, cfg: { ssoIssuer: string; ssoClientId: string; ssoClientSecret: string; secret: string }) => {
  if (!cfg.ssoIssuer || !cfg.ssoClientId || !cfg.ssoClientSecret) return []
  return setupStohrSso(db, {
    issuerUrl: cfg.ssoIssuer,
    clientId: cfg.ssoClientId,
    clientSecret: cfg.ssoClientSecret,
    secret: cfg.secret,
  })
}
import { createStorage } from "./storage/index.ts"
import { createEmailer } from "./email/index.ts"
import { withSecurityHeaders } from "./security/headers.ts"

const config = defineConfig({
  port: env("PORT", { parse: Number, default: "3000" }),
  secret: env("SECRET", { default: "dev-secret-change-me" }),
  databaseUrl: env("DATABASE_URL", { default: "postgres://postgres:postgres@localhost:5432/stohr" }),
  storageDriver: env("STORAGE_DRIVER", { default: "s3" }),
  storageLocalDir: env("STORAGE_LOCAL_DIR", { default: "./.stohr/blobs" }),
  s3Endpoint: env("S3_ENDPOINT", { default: "http://localhost:4000" }),
  s3Bucket: env("S3_BUCKET", { default: "stohr" }),
  s3Region: env("S3_REGION", { default: "us-east-1" }),
  s3AccessKey: env("S3_ACCESS_KEY", { default: "rustfsadmin" }),
  s3SecretKey: env("S3_SECRET_KEY", { default: "rustfsadmin" }),
  appUrl: env("APP_URL", { default: "http://localhost:3001" }),
  federationPublicUrl: env("FEDERATION_PUBLIC_URL", { default: "" }),
  // Legacy env: pre-Admin-Settings releases enabled WebDAV via env var.
  // Read once at boot and seed the DB setting if missing, so upgrades
  // don't silently disable WebDAV. After upgrade the owner manages the
  // toggle from Admin → Settings.
  webdavEnabledLegacy: env("WEBDAV_ENABLED", { default: "" }),
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
  // Opt-in M2M token for Castle (single-node homelab control plane). When
  // set, /castle/* routes mount and accept this bearer for user provisioning.
  // When empty, the integration is invisible and Stohr runs unchanged.
  castleAdminToken: env("CASTLE_ADMIN_TOKEN", { default: "" }),
  // OIDC SSO — when set, Stohr mounts @atlas/sso and the login page surfaces
  // a "Sign in with Castle" CTA. All three are required together; any
  // missing one disables the integration.
  ssoIssuer: env("SSO_ISSUER", { default: "" }),
  ssoClientId: env("SSO_CLIENT_ID", { default: "" }),
  ssoClientSecret: env("SSO_CLIENT_SECRET", { default: "" }),
})

const db = connect({ driver: "postgres", url: config.databaseUrl })
const store = config.storageDriver === "local"
  ? createStorage({ driver: "local", dir: config.storageLocalDir })
  : createStorage({
      driver: "s3",
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

// Seed owner-controlled toggles from legacy env vars if the DB row is
// absent. Only runs on the first boot after this code lands; subsequent
// boots no-op (ON CONFLICT DO NOTHING).
if (config.webdavEnabledLegacy === "true") {
  await seedIfMissing(db, SETTING_WEBDAV_ENABLED, true)
}

const ssoRoutes = await maybeSsoRoutes(db, config)

const fetch = router(
  ...authRoutes(db, config.secret),
  ...passwordRoutes(db, emailer, config.appUrl),
  ...mfaRoutes(db, config.secret),
  ...passkeyRoutes(db, config.secret, { rpId: config.rpId, rpName: config.rpName, rpOrigin: config.rpOrigin }),
  ...sessionRoutes(db, config.secret),
  ...oidcRoutes(db, config.secret, config.appUrl),
  ...adminOidcRoutes(db, config.secret),
  ...ldapRoutes(db, config.secret),
  ...adminLdapRoutes(db, config.secret),
  ...deletionRoutes(db, config.secret),
  ...userRoutes(db, config.secret, store, emailer, config.appUrl),
  ...folderRoutes(db, config.secret, store),
  ...fileRoutes(db, config.secret, store),
  ...shareRoutes(db, config.secret, store),
  ...trashRoutes(db, config.secret, store),
  ...searchRoutes(db, config.secret),
  ...contentSearchRoutes(db, config.secret),
  ...inviteRoutes(db, config.secret),
  ...collabRoutes(db, config.secret, emailer, config.appUrl),
  ...commentRoutes(db, config.secret),
  ...notificationRoutes(db, config.secret),
  ...activityRoutes(db, config.secret),
  ...spaceRoutes(db, config.secret),
  ...messageRoutes(db, config.secret),
  ...photoRoutes(db, config.secret, store),
  ...publicRoutes(db, config.secret, store),
  ...contactRoutes(db, config.secret),
  ...aiRoutes(db, config.secret),
  ...adminRoutes(db, config.secret),
  ...adminUserRoutes(db, config.secret, emailer, config.appUrl),
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
  ...federationRoutes(db, config.secret, config.federationPublicUrl || config.appUrl),
  ...federationFolderRoutes(db, config.secret),
  ...federationFilesRoutes(db, config.secret, store),
  ...pairingReceiverRoutes(db, config.federationPublicUrl || config.appUrl),
  ...webdavRoutes(db, store, config.secret),
  ...adminSettingsRoutes(db, config.secret),
  ...mcpRoutes(db, config.secret, store, config.appUrl),
  ...adminMcpRoutes(db, config.secret, config.appUrl),
  ...mcpServerRoutes(db, config.secret),
  ...castleRoutes(db, config.castleAdminToken),
  ...ssoRoutes,
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
const sweepDeletions = guardedSweep("deleted_accounts", () => sweepDeletedAccounts(db, store))
const sweepFedInvites = guardedSweep("federation_invites", () => sweepExpiredFederationInvites(db))
const sweepFedDrains = guardedSweep("federation_drains", () => sweepFederationDrains(db, store))
const sweepOidcStates = guardedSweep("oidc_states", () => sweepExpiredOidcStates(db))
// Content-search indexer: picks up files where text_indexed_version is
// behind the live version, extracts text, writes back to files. Guarded so
// a slow batch can't stack onto itself.
const tickContentIndexer = guardedSweep("content_index", () => indexContentBatch(db, store, 5))
setInterval(() => { void sweepAuthCodes() }, 5 * 60 * 1000)
setInterval(() => { void sweepDeviceCodes() }, 5 * 60 * 1000)
setInterval(() => { void sweepRefreshTokens() }, 60 * 60 * 1000)
setInterval(() => { void sweepPasswordResets() }, 60 * 60 * 1000)
setInterval(() => { void sweepWebauthn() }, 5 * 60 * 1000)
// Account hard-delete sweep — runs hourly. The grace window is 24h, so
// hourly precision is more than sufficient.
setInterval(() => { void sweepDeletions() }, 60 * 60 * 1000)
setInterval(() => { void sweepFedInvites() }, 60 * 60 * 1000)
setInterval(() => { void sweepFedDrains() }, 10 * 60 * 1000)
setInterval(() => { void sweepOidcStates() }, 5 * 60 * 1000)
// Run the indexer every 30s. Each tick processes up to 5 files; backlog
// drains at ~600 files/5min. Bump the batch size in indexContentBatch if
// you need higher throughput.
setInterval(() => { void tickContentIndexer() }, 30 * 1000)
void sweepAuthCodes()
void sweepDeviceCodes()
void sweepRefreshTokens()
void sweepPasswordResets()
void sweepWebauthn()
void sweepDeletions()
void sweepFedInvites()
void sweepFedDrains()
void sweepOidcStates()
void tickContentIndexer()

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
const storageInfo = config.storageDriver === "local"
  ? `local (${config.storageLocalDir})`
  : `s3 (${config.s3Endpoint})`
console.log(`[stohr] storage: ${storageInfo} (encryption-at-rest is the provider's responsibility — see SECURITY.md)`)
