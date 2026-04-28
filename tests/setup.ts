import { SQL } from "bun"
import type { Connection } from "@atlas/db"
import { connect } from "@atlas/db"
import { migrate } from "@atlas/migrate"

const ADMIN_URL = process.env.TEST_ADMIN_URL ?? "postgres://postgres:postgres@localhost:5432/postgres"
const TEST_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/stohr_test"
const TEST_DB_NAME = (() => {
  const m = TEST_URL.match(/\/([^/?]+)(?:\?|$)/)
  return m?.[1] ?? "stohr_test"
})()

const ensureDb = async () => {
  // Connect to test DB; if it doesn't exist, create it via the admin URL.
  try {
    const probe = new SQL({ url: TEST_URL, max: 1 })
    await probe`SELECT 1`
    await probe.close()
    return
  } catch {
    const admin = new SQL({ url: ADMIN_URL, max: 1 })
    try {
      await admin.unsafe(`CREATE DATABASE ${TEST_DB_NAME}`, [])
    } finally {
      await admin.close()
    }
  }
}

await ensureDb()

export const db: Connection = connect({ driver: "postgres", url: TEST_URL })
await migrate.up(db, "./migrations")

const TABLES = [
  "audit_events",
  "rate_limits",
  "sessions",
  "lemonsqueezy_events",
  "s3_access_keys",
  "apps",
  "shares",
  "file_versions",
  "files",
  "folders",
  "collaborations",
  "invites",
  "invite_requests",
  "payment_config",
  "users",
]

export const truncateAll = async () => {
  await db.execute({
    text: `TRUNCATE TABLE ${TABLES.join(", ")} RESTART IDENTITY CASCADE`,
    values: [],
  })
}

export const TEST_SECRET = "test-secret-do-not-use-in-prod"
