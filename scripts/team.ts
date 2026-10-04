#!/usr/bin/env bun
/**
 * Provision and manage teams from a terminal — what Admin → Teams does in the
 * SPA, for when a client's tenant has to exist before anyone can sign in.
 *
 *   bun scripts/team.ts list [--deleted | --all]
 *   bun scripts/team.ts create <slug> --admin <email> [--name "Acme Inc"] [--quota 500GB]
 *                                     [--admin-name "Jane Doe"] [--admin-username jane]
 *   bun scripts/team.ts quota <slug> <500GB|2TB|unlimited>
 *   bun scripts/team.ts rename <slug> "New name"
 *   bun scripts/team.ts suspend <slug>
 *   bun scripts/team.ts unsuspend <slug>
 *   bun scripts/team.ts delete <slug> [--yes]
 *   bun scripts/team.ts restore <slug>
 *
 * Talks to the database directly, like connect.ts, so it needs no session and
 * no PAT. Creating reuses the API's own helpers, so the result is the same
 * row, the same first admin and the same one-time set-password link.
 *
 * The API caches slug lookups for 30s (misses included), so a change made
 * here can take that long to show on the team's host.
 */
import { connect, from, raw } from "@atlas/db"
import type { Emailer } from "../src/email/index.ts"
import { createEmailer } from "../src/email/index.ts"
import { computeTeamUsage, countTeamUsers } from "../src/teams/members.ts"
import type { Team } from "../src/teams/resolve.ts"
import { ROOT_TEAM_ID, teamFromRow } from "../src/teams/resolve.ts"
import { normalizeSlug, slugProblem } from "../src/teams/slug.ts"
import type { HostConfig } from "../src/teams/urls.ts"
import { teamBaseUrl } from "../src/teams/urls.ts"
import { createTeamUser, issueSetPasswordLink } from "../src/teams/users.ts"

// Stohr's config is built inside src/server.ts, so importing it here would boot
// the server. Bun loads .env automatically; read what we need from it.
const env = (name: string, fallback = ""): string => (process.env[name] ?? "").trim() || fallback

type Db = ReturnType<typeof connect>

const USAGE = `
  bun scripts/team.ts list [--deleted | --all]
  bun scripts/team.ts create <slug> --admin <email> [--name "Acme Inc"] [--quota 500GB]
                                    [--admin-name "Jane Doe"] [--admin-username jane]
  bun scripts/team.ts quota <slug> <500GB|2TB|unlimited>
  bun scripts/team.ts rename <slug> "New name"
  bun scripts/team.ts suspend <slug>
  bun scripts/team.ts unsuspend <slug>
  bun scripts/team.ts delete <slug> [--yes]
  bun scripts/team.ts restore <slug>
`

// typed on the binding so tsc narrows after a call (`if (!x) fail(...)`)
const fail: (msg: string) => never = msg => {
  console.error(`❌ ${msg}`)
  process.exit(1)
}

// flags that take no value; everything else under -- takes the next arg
const BOOL_FLAGS = new Set(["yes", "deleted", "all"])

const parseArgs = (args: string[]): { flags: Record<string, string | true>; rest: string[] } => {
  const flags: Record<string, string | true> = {}
  const rest: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (!a.startsWith("--")) {
      rest.push(a)
      continue
    }
    const key = a.slice(2)
    if (BOOL_FLAGS.has(key)) flags[key] = true
    else flags[key] = args[++i] ?? ""
  }
  return { flags, rest }
}

const str = (v: string | true | undefined): string | null => (typeof v === "string" && v.trim() ? v.trim() : null)

// "500GB", "1.5 TiB", "0", "unlimited" -> bytes; null = unlimited; undefined = unreadable
const parseSize = (input: string): number | null | undefined => {
  const s = input.trim().toLowerCase()
  if (s === "" || s === "0" || s === "unlimited" || s === "none") return null
  const m = s.match(/^(\d+(?:\.\d+)?)\s*([kmgt]?)i?b?$/)
  if (!m) return undefined
  const mult = { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 }[m[2] as "" | "k" | "m" | "g" | "t"]
  return Math.round(Number(m[1]) * mult)
}

const fmtBytes = (b: number): string => {
  if (b < 1024) return `${b} B`
  const units = ["KB", "MB", "GB", "TB"]
  let v = b
  let u = -1
  do {
    v /= 1024
    u++
  } while (v >= 1024 && u < units.length - 1)
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[u]}`
}

const findTeam = async (db: Db, slugRaw: string): Promise<Team> => {
  const slug = normalizeSlug(slugRaw)
  const row = (await db.one(from("teams").where(q => q("slug").equals(slug)))) as Record<string, unknown> | null
  return row ? teamFromRow(row) : fail(`no team with slug "${slug}"`)
}

// the API's logEvent is fire-and-forget; here the process ends right after,
// so the audit row is written synchronously
const audit = async (db: Db, event: string, metadata: Record<string, unknown>): Promise<void> => {
  await db.execute(
    from("audit_events").insert({
      team_id: ROOT_TEAM_ID,
      event,
      metadata: JSON.stringify({ ...metadata, via: "cli" }),
    }),
  )
}

const update = async (db: Db, team: Team, patch: Record<string, unknown>, event: string): Promise<void> => {
  await db.execute(
    from("teams")
      .where(q => q("id").equals(team.id))
      .update(patch),
  )
  await audit(db, event, { team_id: team.id, fields: Object.keys(patch) })
}

const list = async (db: Db, hosts: HostConfig, flags: Record<string, string | true>): Promise<void> => {
  let q = from("teams").orderBy("id", "ASC")
  if (flags.deleted) q = q.where(p => p("deleted_at").isNotNull())
  else if (!flags.all) q = q.where(p => p("deleted_at").isNull())
  const rows = (await db.all(q)) as Array<Record<string, unknown>>
  if (rows.length === 0) {
    console.log("no teams")
    return
  }
  for (const row of rows) {
    const t = teamFromRow(row)
    const [users, usage] = await Promise.all([countTeamUsers(db, t.id), computeTeamUsage(db, t.id)])
    const state = t.deleted_at ? "deleted" : t.suspended_at ? "suspended" : "live"
    const cap = t.quota_bytes ? fmtBytes(t.quota_bytes) : "unlimited"
    console.log(
      [
        String(t.id).padStart(3),
        t.slug.padEnd(20),
        t.name.slice(0, 28).padEnd(28),
        state.padEnd(9),
        `${String(users).padStart(4)} users`,
        `${fmtBytes(usage.total).padStart(9)} / ${cap.padEnd(9)}`,
        teamBaseUrl(t, hosts),
      ].join("  "),
    )
  }
}

const create = async (
  db: Db,
  hosts: HostConfig,
  emailer: Emailer,
  slugRaw: string | undefined,
  flags: Record<string, string | true>,
): Promise<void> => {
  if (!hosts.rootDomain) fail("ROOT_DOMAIN is not set; a team's host would never resolve. Set it in .env first.")
  const slug = normalizeSlug(slugRaw ?? "")
  const problem = slugProblem(slug)
  if (problem) fail(problem)
  const adminEmail = str(flags.admin)?.toLowerCase()
  if (!adminEmail) fail("--admin <email> is required: the team's first admin")
  const quotaIn = str(flags.quota) ?? "0"
  const quota = parseSize(quotaIn)
  if (quota === undefined) fail(`can't read --quota "${quotaIn}" (try 500GB, 2TB, or unlimited)`)

  // includes soft-deleted teams: the slug is spoken for until the purge
  const taken = await db.one(
    from("teams")
      .where(q => q("slug").equals(slug))
      .select("id"),
  )
  if (taken) fail(`slug "${slug}" is already in use (a deleted team keeps its slug until the purge)`)

  const name = str(flags.name) ?? slug
  const inserted = (await db.execute(
    from("teams")
      .insert({ slug, name, quota_bytes: quota })
      .returning("id", "slug", "name", "quota_bytes", "suspended_at", "deleted_at", "created_at"),
  )) as Array<Record<string, unknown>>
  const team = teamFromRow(inserted[0]!)

  const created = await createTeamUser(db, team, {
    email: adminEmail,
    name: str(flags["admin-name"]),
    username: str(flags["admin-username"]),
    teamAdmin: true,
  })
  if (!created.ok) {
    // a team without an admin is unreachable; undo rather than leave it
    await db.execute(
      from("teams")
        .where(q => q("id").equals(team.id))
        .del(),
    )
    fail(created.error)
  }
  const link = await issueSetPasswordLink(db, emailer, hosts, team, created.user)
  await audit(db, "admin.team_created", {
    team_id: team.id,
    slug,
    admin_user_id: created.user.id,
    emailed: link.emailed,
  })

  console.log(`
  ✔ team "${name}" (${slug}) created — ${teamBaseUrl(team, hosts)}
  → first admin: ${created.user.email} (@${created.user.username})
  → storage cap: ${quota ? fmtBytes(quota) : "unlimited"}

  ${link.emailed ? "Set-password link (also emailed to them):" : "Email is off — hand them this set-password link:"}

${link.url}

  Shown once; it expires in an hour. They can request another from the
  sign-in page's "Forgot your password?" on the team's host.
`)
}

const main = async () => {
  const [command, ...args] = process.argv.slice(2)
  const { flags, rest } = parseArgs(args)
  if (!command || command === "help" || command === "--help") {
    console.log(USAGE)
    process.exitCode = command ? 0 : 1
    return
  }

  const db = connect({
    driver: "postgres",
    url: env("DATABASE_URL", "postgres://postgres:postgres@localhost:5432/stohr"),
  })
  const hosts: HostConfig = {
    rootDomain: env("ROOT_DOMAIN").toLowerCase() || null,
    appUrl: env("APP_URL", "http://localhost:3001"),
  }
  // with email off the real emailer prints the whole message to the console;
  // this cli prints the link itself, so stay quiet
  const emailer: Emailer = env("RESEND_API_KEY")
    ? createEmailer({ apiKey: env("RESEND_API_KEY"), from: env("RESEND_FROM"), apiUrl: env("RESEND_API_URL") })
    : { enabled: false, send: async () => ({ ok: true, logged: true }) }

  try {
    switch (command) {
      case "list":
        await list(db, hosts, flags)
        break
      case "create":
        await create(db, hosts, emailer, rest[0], flags)
        break
      case "quota": {
        const team = await findTeam(db, rest[0] ?? "")
        const quota = parseSize(rest[1] ?? "")
        if (quota === undefined) fail(`can't read "${rest[1]}" (try 500GB, 2TB, or unlimited)`)
        await update(db, team, { quota_bytes: quota }, "admin.team_edited")
        console.log(`✔ ${team.slug}: storage cap ${quota ? fmtBytes(quota) : "unlimited"}`)
        break
      }
      case "rename": {
        const team = await findTeam(db, rest[0] ?? "")
        const name = (rest[1] ?? "").trim()
        if (!name) fail("a new name is required")
        await update(db, team, { name }, "admin.team_edited")
        console.log(`✔ ${team.slug}: renamed to "${name}"`)
        break
      }
      case "suspend": {
        const team = await findTeam(db, rest[0] ?? "")
        if (team.id === ROOT_TEAM_ID) fail("the root team cannot be suspended")
        if (team.suspended_at) fail(`${team.slug} is already suspended`)
        await update(db, team, { suspended_at: raw("NOW()") }, "admin.team_edited")
        console.log(`✔ ${team.slug} suspended — every request on ${teamBaseUrl(team, hosts)} is refused within 30s`)
        break
      }
      case "unsuspend": {
        const team = await findTeam(db, rest[0] ?? "")
        if (!team.suspended_at) fail(`${team.slug} is not suspended`)
        await update(db, team, { suspended_at: null }, "admin.team_edited")
        console.log(`✔ ${team.slug} unsuspended`)
        break
      }
      case "delete": {
        const team = await findTeam(db, rest[0] ?? "")
        if (team.id === ROOT_TEAM_ID) fail("the root team cannot be deleted")
        if (team.deleted_at) fail(`${team.slug} is already scheduled for deletion`)
        const users = await countTeamUsers(db, team.id)
        if (!flags.yes) {
          const ok = confirm(
            `Delete "${team.name}" (${team.slug})? Its host stops resolving now; ${users} user(s) and their files are purged after 24h.`,
          )
          if (!ok) {
            console.log("aborted")
            break
          }
        }
        await update(db, team, { deleted_at: raw("NOW()") }, "admin.team_deleted")
        console.log(
          `✔ ${team.slug} scheduled for deletion — purge in 24h; \`restore ${team.slug}\` undoes it until then`,
        )
        break
      }
      case "restore": {
        const team = await findTeam(db, rest[0] ?? "")
        if (!team.deleted_at) fail(`${team.slug} is not scheduled for deletion`)
        await update(db, team, { deleted_at: null }, "admin.team_restored")
        console.log(`✔ ${team.slug} restored — ${teamBaseUrl(team, hosts)} resolves again within 30s`)
        break
      }
      default:
        console.error(`unknown command "${command}"`)
        console.log(USAGE)
        process.exitCode = 1
    }
  } finally {
    await db.close()
  }
}

await main()
