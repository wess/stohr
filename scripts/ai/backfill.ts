#!/usr/bin/env bun
// Trigger /admin/ai/backfill so existing files get embedded under the
// active model. The job runner picks them up; watch progress at
// `bun run ai:status` or `GET /admin/ai`.
//
// Auth: pass an owner JWT or PAT via $STOHR_TOKEN.
//
// Usage:
//   STOHR_TOKEN=... bun run ai:backfill
//   STOHR_TOKEN=... bun run ai:backfill --force --limit=20000
//   bun run ai:backfill --url=https://your.tld/api  # override base
//
// Default base URL is http://localhost:3000 (the local docker api),
// since this script is meant to run on the server.

import { die, step } from "../lib/run.ts"

const arg = (name: string): string | undefined => {
  const prefix = `--${name}=`
  const found = process.argv.find(a => a.startsWith(prefix))
  return found?.slice(prefix.length)
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`)

const main = async () => {
  const token = process.env.STOHR_TOKEN
  if (!token) die("STOHR_TOKEN env required (owner JWT or stohr_pat_…)")

  const base = arg("url") ?? process.env.STOHR_API_URL ?? "http://localhost:3000"
  const force = flag("force")
  const limit = arg("limit") ? Number(arg("limit")) : undefined

  step(`POST ${base}/admin/ai/backfill (force=${force}, limit=${limit ?? "default"})`)
  const res = await fetch(`${base}/admin/ai/backfill`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ force, ...(limit ? { limit } : {}) }),
  })
  const body = await res.json().catch(() => ({})) as Record<string, unknown>
  if (!res.ok) die(`backfill failed (${res.status}): ${JSON.stringify(body)}`)
  step(`enqueued ${body.enqueued} of ${body.scanned} files (model ${body.model})`)
  step("watch progress: bun run ai:status")
}

await main()
