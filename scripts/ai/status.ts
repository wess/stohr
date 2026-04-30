#!/usr/bin/env bun
// Read-only status snapshot — prints what /admin/ai returns plus a
// human-friendly summary. Useful while a backfill is draining.
//
// Usage:
//   STOHR_TOKEN=... bun run ai:status

import { die } from "../lib/run.ts"

const main = async () => {
  const token = process.env.STOHR_TOKEN
  if (!token) die("STOHR_TOKEN env required (owner JWT or stohr_pat_…)")

  const base = process.env.STOHR_API_URL ?? "http://localhost:3000"
  const res = await fetch(`${base}/admin/ai`, {
    headers: { authorization: `Bearer ${token}` },
  })
  const body = await res.json().catch(() => ({})) as Record<string, unknown>
  if (!res.ok) die(`status failed (${res.status}): ${JSON.stringify(body)}`)

  const total = Number(body.files_total ?? 0)
  const done = Number(body.files_embedded ?? 0)
  const pct = total > 0 ? Math.round((done / total) * 100) : 0
  const bar = "█".repeat(Math.floor(pct / 2.5)) + "·".repeat(40 - Math.floor(pct / 2.5))

  process.stdout.write(`enabled: ${body.enabled}\n`)
  process.stdout.write(`model:   ${body.model ?? "—"} (dim ${body.dim ?? "—"})\n`)
  if (body.enabled === false) process.stdout.write(`reason:  ${body.reason ?? "—"}\n`)
  process.stdout.write(`coverage: ${done} / ${total} files [${bar}] ${pct}%\n`)
  process.stdout.write(`jobs pending: ${body.jobs_pending ?? 0}    dead: ${body.jobs_dead ?? 0}\n`)
}

await main()
