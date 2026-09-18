#!/usr/bin/env bun
/**
 * Prints a connection token another service can paste to use this Stohr install
 * as S3-compatible storage.
 *
 *   bun run connect                    # for the first owner account
 *   bun run connect --user wess        # for a specific user
 *   bun run connect --name "Inkling"   # label the key
 *   bun run connect --url https://files.example.com   # override APP_URL
 *
 * The token carries the endpoint, the bucket, and both halves of the key pair
 * in one string, so the other side has one field to fill rather than five to
 * get subtly wrong.
 *
 * It is not encrypted. It carries a secret key and should be treated like one:
 * shown once, pasted, and not committed.
 */
import { connect, from } from "@atlas/db"
import { generateAccessKey, generateSecretKey } from "../src/s3keys/generate.ts"
import { normalizeUsername } from "../src/util/username.ts"

// Stohr's config is built inside src/server.ts, so importing it here would boot
// the server. Bun loads .env automatically; read what we need from it.
const env = (name: string, fallback: string): string => (process.env[name] ?? "").trim() || fallback

const STOHR_PREFIX = "sthc"

const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

const encodeConnection = (
  prefix: string,
  value: { v: 1; url: string; bucket: string; accessKey: string; secretKey: string; name?: string },
): string => `${prefix}_${Buffer.from(JSON.stringify(value), "utf8").toString("base64url")}`

const main = async () => {
  const db = connect({
    driver: "postgres",
    url: env("DATABASE_URL", "postgres://postgres:postgres@localhost:5432/stohr"),
  })

  const username = arg("--user")
  // Ownership can be transferred and user 1 can be deleted, so "first owner"
  // means the oldest live account that is an owner now, not the lowest id.
  const owner = (await db.one(
    from("users")
      .where(q => (username ? q("username").equals(normalizeUsername(username)) : q("is_owner").equals(true)))
      .where(q => q("deleted_at").isNull())
      .orderBy("id", "ASC")
      .limit(1)
      .select("id", "username"),
  )) as { id: number; username: string } | null

  if (!owner) {
    console.error(username ? `no user named ${username}` : "no owner account — sign up first")
    process.exitCode = 1
    await db.close()
    return
  }

  const name = arg("--name") ?? "Connection token"
  const accessKey = generateAccessKey()
  const secretKey = generateSecretKey()

  await db.execute(
    from("s3_access_keys").insert({
      user_id: owner.id,
      access_key: accessKey,
      secret_key: secretKey,
      name,
    }),
  )

  // The S3 API lives under /s3 and the bucket is the username — see docs/S3.md.
  // APP_URL is the public origin; the web server passes /s3 through to the API
  // untouched (src/web/serve.ts), so the same URL works in dev and behind Caddy.
  const base = (arg("--url") ?? env("APP_URL", "http://localhost:3001")).replace(/\/$/, "")
  const token = encodeConnection(STOHR_PREFIX, {
    v: 1,
    url: `${base}/s3`,
    bucket: owner.username,
    accessKey,
    secretKey,
    name: "Stohr",
  })

  console.log(`
  Stohr connection token — paste this into the other service.

${token}

  It carries ${base}/s3, the bucket "${owner.username}", and an access key named "${name}".
  Shown once. Revoke it any time from Settings -> Developer.

  In Inkling:  set STORAGE_CONNECTION=<token> and STORAGE_DRIVER=s3
`)

  await db.close()
}

await main()
