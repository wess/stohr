import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import type { StorageHandle } from "../storage/index.ts"
import type { FileRow, FolderRow } from "../permissions/index.ts"
import { getAction } from "./registry.ts"
import type {
  Action,
  EventName,
  FolderActionRow,
  RunStatus,
  Subject,
} from "./types.ts"
import { loadUserAction, runUserAction } from "./user/execute.ts"
import { parseUserAction, type UserActionRow } from "./user/types.ts"
import { parseUserSlug } from "./user/slug.ts"

const ACTION_TIMEOUT_MS = 30_000
const MAX_DEPTH = 1

const parseConfig = (raw: string): Record<string, unknown> => {
  try {
    const v = JSON.parse(raw)
    return v && typeof v === "object" && !Array.isArray(v) ? v : {}
  } catch {
    return {}
  }
}

const wrapUserActionAsAction = (row: UserActionRow): Action => {
  const parsed = parseUserAction(row)
  return {
    slug: `u/${row.id}`,
    name: row.name,
    description: row.description ?? "",
    version: "1.0.0",
    author: { name: "User" },
    permissions: [],
    events: parsed.triggers,
    subjects: ["file", "folder"],
    configSchema: {},
    run: async (ctx) => runUserAction(ctx, row),
  }
}

const resolveAction = async (db: Connection, slug: string): Promise<Action | null> => {
  const userId = parseUserSlug(slug)
  if (userId !== null) {
    const row = await loadUserAction(db, userId)
    return row ? wrapUserActionAsAction(row) : null
  }
  return getAction(slug)
}

const withTimeout = async <T>(p: Promise<T>, ms: number): Promise<T> => {
  let handle: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<never>((_, reject) => {
    handle = setTimeout(() => reject(new Error(`Action timed out after ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([p, timeout])
  } finally {
    if (handle) clearTimeout(handle)
  }
}

export type RunSummary = {
  id: number
  slug: string
  status: RunStatus
  result: Record<string, unknown> | null
  error: string | null
}

export type FireEventArgs = {
  db: Connection
  store: StorageHandle
  event: EventName
  folder: FolderRow
  subject: Subject
  actor: { id: number }
  depth?: number
}

export const fireEvent = async (args: FireEventArgs): Promise<RunSummary[]> => {
  const { db, store, event, folder, subject, actor } = args
  const depth = args.depth ?? 0
  if (depth > MAX_DEPTH) return []

  const rows = await db.all(
    from("folder_actions")
      .where(q => q("folder_id").equals(folder.id))
      .where(q => q("event").equals(event))
      .where(q => q("enabled").equals(true))
      .orderBy("created_at", "ASC"),
  ) as FolderActionRow[]

  if (rows.length === 0) return []

  const summaries: RunSummary[] = []
  let currentSubject: Subject | null = subject

  for (const row of rows) {
    const action = await resolveAction(db, row.slug)
    const inserted = await db.execute(
      from("folder_action_runs")
        .insert({
          folder_action_id: row.id,
          triggered_event: event,
          subject_kind: subject.kind,
          subject_id: subject.row.id,
          status: "succeeded",
        })
        .returning("id"),
    ) as Array<{ id: number }>
    const runId = inserted[0]!.id

    if (!action) {
      const err = `Unknown action slug: ${row.slug}`
      await db.execute(
        from("folder_action_runs")
          .where(q => q("id").equals(runId))
          .update({ status: "failed", finished_at: new Date(), error: err }),
      )
      summaries.push({ id: runId, slug: row.slug, status: "failed", result: null, error: err })
      continue
    }

    if (!action.subjects.includes(subject.kind) || !action.events.includes(event)) {
      await db.execute(
        from("folder_action_runs")
          .where(q => q("id").equals(runId))
          .update({ status: "skipped", finished_at: new Date(), error: "event/subject not supported by action" }),
      )
      summaries.push({ id: runId, slug: row.slug, status: "skipped", result: null, error: "event/subject mismatch" })
      continue
    }

    if (!currentSubject) {
      await db.execute(
        from("folder_action_runs")
          .where(q => q("id").equals(runId))
          .update({ status: "skipped", finished_at: new Date(), error: "Subject removed by an earlier action" }),
      )
      summaries.push({ id: runId, slug: row.slug, status: "skipped", result: null, error: "subject gone" })
      continue
    }

    try {
      const outcome = await withTimeout(
        action.run({
          db,
          store,
          folder,
          event,
          subject: currentSubject,
          actor,
          ownerId: folder.user_id,
          config: parseConfig(row.config),
          depth,
        }),
        ACTION_TIMEOUT_MS,
      )
      if (outcome.ok) {
        await db.execute(
          from("folder_action_runs")
            .where(q => q("id").equals(runId))
            .update({
              status: "succeeded",
              finished_at: new Date(),
              result: outcome.result ? JSON.stringify(outcome.result) : null,
            }),
        )
        summaries.push({ id: runId, slug: row.slug, status: "succeeded", result: outcome.result ?? null, error: null })
      } else {
        await db.execute(
          from("folder_action_runs")
            .where(q => q("id").equals(runId))
            .update({ status: "failed", finished_at: new Date(), error: outcome.error }),
        )
        summaries.push({ id: runId, slug: row.slug, status: "failed", result: null, error: outcome.error })
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      await db.execute(
        from("folder_action_runs")
          .where(q => q("id").equals(runId))
          .update({ status: "failed", finished_at: new Date(), error: message }),
      )
      summaries.push({ id: runId, slug: row.slug, status: "failed", result: null, error: message })
    }

    if (currentSubject) currentSubject = await refreshSubject(db, currentSubject)
  }

  return summaries
}

const refreshSubject = async (db: Connection, subject: Subject): Promise<Subject | null> => {
  if (subject.kind === "file") {
    const row = await db.one(
      from("files").where(q => q("id").equals(subject.row.id)),
    ) as FileRow | null
    return row ? { kind: "file", row } : null
  }
  const row = await db.one(
    from("folders").where(q => q("id").equals(subject.row.id)),
  ) as FolderRow | null
  return row ? { kind: "folder", row } : null
}
