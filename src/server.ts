import { defineConfig, env } from "@atlas/config"
import { connect } from "@atlas/db"
import { migrate } from "@atlas/migrate"
import { serve } from "@atlas/server"
import { authRoutes } from "./auth/index.ts"
import { folderRoutes } from "./folders/index.ts"
import { fileRoutes } from "./files/index.ts"
import { shareRoutes } from "./shares/index.ts"
import { trashRoutes } from "./trash/index.ts"
import { userRoutes } from "./users/index.ts"
import { searchRoutes } from "./search/index.ts"
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

serve({
  port: config.port,
  routes: [
    ...authRoutes(db, config.secret),
    ...userRoutes(db, config.secret, store),
    ...folderRoutes(db, config.secret, store),
    ...fileRoutes(db, config.secret, store),
    ...shareRoutes(db, config.secret, store),
    ...trashRoutes(db, config.secret, store),
    ...searchRoutes(db, config.secret),
  ],
})

console.log(`[stohr] api on http://localhost:${config.port}`)
