#!/usr/bin/env bun
// Apply an upstream update. Run AFTER `git pull` (or as a single step:
// `git pull && bun run update`). Rebuilds images, ensures the AI model
// is present if AI is enabled, recreates services, verifies health.
//
//   bun run update
//
// Notes:
//   - Migrations run automatically when the api container boots, so
//     we don't run them as a separate step.
//   - Existing volumes (pgdata, baimodels, caddy*) are preserved.

import { existsSync } from "node:fs"
import { join } from "node:path"
import { readEnvFile } from "./lib/env.ts"
import { run, runOut, step, die } from "./lib/run.ts"
import { waitForHealth } from "./lib/health.ts"

const main = async () => {
  if (!existsSync(".env")) die(".env missing — run `bun run setup` first")
  const env = readEnvFile()

  step("syncing submodules (atlas)")
  run(["git", "submodule", "update", "--init", "--recursive"])

  step("rebuilding images")
  run(["docker", "compose", "build"])

  if (env.AI_EMBED_MODEL) {
    // Check whether the model is already in the baimodels volume.
    // bai's CLI exits 0 either way and prints "already cached:" if it is —
    // we just always run pull; it's a no-op when present.
    step(`ensuring AI model is present: ${env.AI_EMBED_MODEL}`)
    run(["docker", "compose", "run", "--rm", "api", "bunx", "bai", "pull", env.AI_EMBED_MODEL])
  }

  step("recreating services")
  run(["docker", "compose", "up", "-d"])

  // Compare migration count before/after for a friendly summary. Soft-fail
  // if psql in the postgres container can't be reached — the api boot
  // log is the source of truth anyway.
  const migrationCount = (): number | null => {
    const r = runOut(
      ["docker", "compose", "exec", "-T", "postgres", "psql", "-U", "postgres", "-d", "stohr",
        "-tAc", "SELECT COUNT(*) FROM atlas_migrations"],
      { allowFail: true },
    )
    if (r.code !== 0) return null
    const n = Number(r.stdout.trim())
    return Number.isFinite(n) ? n : null
  }
  const after = migrationCount()

  const port = env.PORT ?? "3000"
  await waitForHealth(`http://localhost:${port}/healthz`, { timeoutMs: 90_000 })

  step(`update applied${after !== null ? ` (${after} migrations on disk)` : ""}`)
}

await main()
