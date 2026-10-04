import type { Connection } from "@atlas/db"
import { router } from "@atlas/server"
import { actionRoutes } from "../../src/actions/index.ts"
import { aiRoutes } from "../../src/ai/routes.ts"
import { appRoutes } from "../../src/apps/index.ts"
import { authRoutes } from "../../src/auth/index.ts"
import { passwordRoutes } from "../../src/auth/password.ts"
import { castleRoutes } from "../../src/castle/index.ts"
import { federationRoutes } from "../../src/federation/index.ts"
import { pairingReceiverRoutes } from "../../src/federation/pairing.ts"
import { fileRoutes } from "../../src/files/index.ts"
import { folderRoutes } from "../../src/folders/index.ts"
import { adminMcpRoutes, mcpRoutes } from "../../src/mcp/index.ts"
import { mcpServerRoutes } from "../../src/mcp/servers.ts"
import { oauthAuthorizeRoutes } from "../../src/oauth/authorize.ts"
import { oauthClientRoutes } from "../../src/oauth/clients.ts"
import { deviceAuthorizeRoutes } from "../../src/oauth/device.ts"
import { oauthTokenRoutes } from "../../src/oauth/token.ts"
import { photoRoutes } from "../../src/photos/index.ts"
import { publicRoutes } from "../../src/public/index.ts"
import { s3Routes } from "../../src/s3/index.ts"
import { s3KeyRoutes } from "../../src/s3keys/index.ts"
import { adminSettingsRoutes } from "../../src/settings/index.ts"
import { shareRoutes } from "../../src/shares/index.ts"
import type { HostConfig } from "../../src/teams/index.ts"
import { adminTeamRoutes, teamRoutes, withTeams } from "../../src/teams/index.ts"
import { uploadRoutes } from "../../src/uploads/index.ts"
import { userRoutes } from "../../src/users/index.ts"
import { webdavRoutes } from "../../src/webdav/index.ts"
import { webhookRoutes } from "../../src/webhooks/index.ts"
import { fakeEmailer, fakeStore, TEST_APP_URL } from "./http.ts"
import { ROOT } from "./teams.ts"

// The protocol surfaces (S3, WebDAV, MCP, OAuth, uploads, photos, public
// links) plus the root-only admin routes, with host routing on. buildApp in
// http.ts leaves most of these out; this router exists for the team tests.

export const CASTLE_TOKEN = "castle-test-token"

export const buildProtocolApp = (db: Connection, secret: string) => {
  const hosts: HostConfig = { rootDomain: ROOT, appUrl: TEST_APP_URL }
  const routes = router(
    ...authRoutes(db, secret),
    ...passwordRoutes(db, fakeEmailer, TEST_APP_URL),
    ...userRoutes(db, secret, fakeStore, fakeEmailer, TEST_APP_URL),
    ...folderRoutes(db, secret, fakeStore),
    ...fileRoutes(db, secret, fakeStore),
    ...uploadRoutes(db, fakeStore, secret),
    ...shareRoutes(db, secret, fakeStore),
    ...publicRoutes(db, secret, fakeStore),
    ...photoRoutes(db, secret, fakeStore),
    ...appRoutes(db, secret),
    ...s3KeyRoutes(db, secret),
    ...s3Routes(db, fakeStore),
    ...webdavRoutes(db, fakeStore),
    ...adminSettingsRoutes(db, secret),
    ...mcpRoutes(db, secret, fakeStore, TEST_APP_URL),
    ...adminMcpRoutes(db, secret, TEST_APP_URL),
    ...mcpServerRoutes(db, secret),
    ...oauthClientRoutes(db, secret),
    ...oauthAuthorizeRoutes(db, secret),
    ...oauthTokenRoutes(db, secret),
    ...deviceAuthorizeRoutes(db, secret),
    ...federationRoutes(db, secret, TEST_APP_URL),
    ...pairingReceiverRoutes(db, TEST_APP_URL),
    ...aiRoutes(db, secret),
    ...castleRoutes(db, CASTLE_TOKEN),
    ...webhookRoutes(db, secret),
    ...actionRoutes(db, secret),
    ...adminTeamRoutes(db, secret, fakeEmailer, hosts),
    ...teamRoutes(db, secret, fakeEmailer, fakeStore, hosts),
  )
  return withTeams(db, routes, hosts)
}
