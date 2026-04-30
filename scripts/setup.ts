#!/usr/bin/env bun
// First-time setup on a fresh checkout. Idempotent — safe to re-run.
// Run from the repo root on the server (or any host running docker compose).
//
//   bun run setup
//
// Steps:
//   1. Verify .env exists; bail with a hint if not
//   2. Validate required vars (SECRET strength, POSTGRES_PASSWORD)
//   3. git submodule update (atlas)
//   4. docker compose build
//   5. If AI_EMBED_MODEL is set, pull the model into the baimodels volume
//   6. docker compose up -d
//   7. Wait for /healthz
//   8. Print summary

import { existsSync } from "node:fs"
import { readEnvFile, envFilePath } from "./lib/env.ts"
import { run, step, die } from "./lib/run.ts"
import { waitForHealth } from "./lib/health.ts"

const main = async () => {
  step("checking .env")
  const envPath = envFilePath()
  if (!existsSync(envPath)) {
    die(`.env not found at ${envPath} — copy .env.example to .env and edit it first`)
  }
  const env = readEnvFile()

  const secret = env.SECRET ?? ""
  if (!secret || secret === "change-me-in-production" || secret === "dev-secret-change-me") {
    die(`SECRET in .env is empty or default — generate one with: openssl rand -hex 32`)
  }
  if (secret.length < 32) {
    die(`SECRET is too short (${secret.length} chars) — min 32 in production`)
  }
  if (!env.POSTGRES_PASSWORD) {
    die("POSTGRES_PASSWORD is empty in .env — set a strong password (used by the bundled postgres container)")
  }

  step("syncing submodules (atlas)")
  run(["git", "submodule", "update", "--init", "--recursive"])

  step("building images")
  run(["docker", "compose", "build"])

  if (env.AI_EMBED_MODEL) {
    step(`AI is enabled — pulling model: ${env.AI_EMBED_MODEL}`)
    run(["docker", "compose", "run", "--rm", "api", "bunx", "bai", "pull", env.AI_EMBED_MODEL])
  } else {
    step("AI_EMBED_MODEL not set — skipping model pull (semantic search will be disabled)")
  }

  step("starting services")
  run(["docker", "compose", "up", "-d"])

  // Default to the docker-internal port (3000) when accessed via Caddy
  // we need :80 / :443; for the immediate health check the api service
  // is reachable on the docker bridge but we exposed it directly via
  // the api container too in dev compositions. Use the port from .env.
  const port = env.PORT ?? "3000"
  const healthUrl = `http://localhost:${port}/healthz`
  try {
    await waitForHealth(healthUrl, { timeoutMs: 90_000 })
  } catch (err) {
    die(`health check failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  step("done")
  process.stdout.write([
    "",
    "  Stohr is up. Tail logs:    docker compose logs -f api",
    "  Re-deploy after a pull:    bun run update",
    env.AI_EMBED_MODEL ? "  Backfill embeddings:       STOHR_TOKEN=... bun run ai:backfill" : "",
    env.DOMAIN ? `  Public URL:                https://${env.DOMAIN}` : "  Local API:                 " + healthUrl,
    "",
  ].filter(Boolean).join("\n"))
}

await main()
