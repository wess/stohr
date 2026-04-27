import { defineConfig, env } from "@atlas/config"
import { connect } from "@atlas/db"
import { migrate } from "@atlas/migrate"
import { router } from "@atlas/server"
import { authRoutes } from "./auth/index.ts"
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
import { createStorage } from "./storage/index.ts"

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
)

Bun.serve({
  port: config.port,
  hostname: "0.0.0.0",
  fetch,
  maxRequestBodySize: Number.MAX_SAFE_INTEGER,
  idleTimeout: 0,
})

console.log(`[stohr] api on http://localhost:${config.port}`)
