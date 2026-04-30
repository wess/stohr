import type { Connection } from "@atlas/db"
import { from, raw } from "@atlas/db"
import { log } from "../log/index.ts"

// Durable, at-least-once background jobs.
//
// - enqueue(db, type, payload, opts?) inserts a row; the dispatcher polls.
// - register(type, handler) wires a handler. Handlers throw to signal
//   transient failure; the row will be retried with exponential backoff
//   up to max_attempts, then marked dead.
// - registerRecurring(type, intervalMs) is a thin convenience that re-enqueues
//   the same job after each successful run, giving cron-without-cron.
//
// Concurrency: each dispatcher tick claims up to BATCH rows using
// FOR UPDATE SKIP LOCKED so multiple API processes can share the queue
// without double-running a job.

export type JobRow = {
  id: number | string
  type: string
  payload: Record<string, unknown>
  attempts: number
  max_attempts: number
}

type Handler = (db: Connection, payload: Record<string, unknown>, ctx: { id: number | string; attempts: number }) => Promise<void>

const handlers = new Map<string, Handler>()
const recurring = new Map<string, number>()

const BATCH = 5
const TICK_MS = Number(process.env.JOBS_TICK_MS ?? 2000)

export const register = (type: string, handler: Handler): void => {
  handlers.set(type, handler)
}

export const registerRecurring = (type: string, intervalMs: number, handler: Handler): void => {
  handlers.set(type, handler)
  recurring.set(type, intervalMs)
}

export type EnqueueOptions = {
  runAt?: Date
  maxAttempts?: number
}

export const enqueue = async (
  db: Connection,
  type: string,
  payload: Record<string, unknown> = {},
  opts: EnqueueOptions = {},
): Promise<number> => {
  const rows = await db.execute(
    from("jobs").insert({
      type,
      payload: JSON.stringify(payload),
      run_at: opts.runAt ?? raw("NOW()"),
      max_attempts: opts.maxAttempts ?? 5,
    }).returning("id"),
  ) as Array<{ id: number | string }>
  return Number(rows[0]!.id)
}

const backoffSeconds = (attempts: number): number => {
  // 30s, 2m, 8m, 32m, 2h. Capped to keep retries from drifting too far.
  const base = 30 * Math.pow(4, attempts - 1)
  return Math.min(base, 60 * 60 * 2)
}

const claim = async (db: Connection): Promise<JobRow[]> => {
  // Atomic claim: lock + bump attempts + status in one statement so a crash
  // mid-tick can't leak rows. Locked rows reset to pending if we crash —
  // a separate sweep reaps "running" rows whose locked_at is older than
  // a generous timeout.
  const text = `
    WITH ready AS (
      SELECT id FROM jobs
      WHERE status = 'pending' AND run_at <= NOW()
      ORDER BY run_at
      FOR UPDATE SKIP LOCKED
      LIMIT $1
    )
    UPDATE jobs j
    SET status = 'running', locked_at = NOW(), attempts = j.attempts + 1, updated_at = NOW()
    FROM ready
    WHERE j.id = ready.id
    RETURNING j.id, j.type, j.payload, j.attempts, j.max_attempts
  `
  const rows = await db.execute({ text, values: [BATCH] }) as Array<{
    id: number | string
    type: string
    payload: Record<string, unknown> | string
    attempts: number
    max_attempts: number
  }>
  return rows.map(r => ({
    ...r,
    payload: typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload,
  }))
}

const finishOk = async (db: Connection, id: number | string) => {
  await db.execute(
    from("jobs").where(q => q("id").equals(id)).update({
      status: "done",
      locked_at: null,
      last_error: null,
      updated_at: raw("NOW()"),
    }),
  )
}

const finishFail = async (db: Connection, job: JobRow, err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err)
  if (job.attempts >= job.max_attempts) {
    await db.execute(
      from("jobs").where(q => q("id").equals(job.id)).update({
        status: "dead",
        locked_at: null,
        last_error: msg,
        updated_at: raw("NOW()"),
      }),
    )
    log.error("job dead", { job_id: String(job.id), type: job.type, attempts: job.attempts, err: msg })
  } else {
    const delay = backoffSeconds(job.attempts)
    await db.execute({
      text: `UPDATE jobs SET status = 'pending', locked_at = NULL, last_error = $1, run_at = NOW() + ($2 || ' seconds')::interval, updated_at = NOW() WHERE id = $3`,
      values: [msg, String(delay), job.id],
    })
    log.warn("job retry scheduled", { job_id: String(job.id), type: job.type, attempts: job.attempts, retry_in_s: delay, err: msg })
  }
}

const reapStuck = async (db: Connection) => {
  // Anything 'running' for >10 minutes means the worker died mid-job.
  // Bump it back to pending so a fresh dispatcher tick can retry it.
  await db.execute({
    text: `UPDATE jobs SET status = 'pending', locked_at = NULL WHERE status = 'running' AND locked_at < NOW() - interval '10 minutes'`,
    values: [],
  })
}

const sweepDone = async (db: Connection) => {
  // Trim done rows after 7 days. Dead rows are kept indefinitely so admins
  // can investigate persistent failures.
  await db.execute({
    text: `DELETE FROM jobs WHERE status = 'done' AND updated_at < NOW() - interval '7 days'`,
    values: [],
  })
}

const runOne = async (db: Connection, job: JobRow): Promise<void> => {
  const handler = handlers.get(job.type)
  if (!handler) {
    await finishFail(db, job, new Error(`no handler registered for job type "${job.type}"`))
    return
  }
  const start = performance.now()
  try {
    await handler(db, job.payload, { id: job.id, attempts: job.attempts })
    await finishOk(db, job.id)
    log.info("job done", {
      job_id: String(job.id),
      type: job.type,
      attempts: job.attempts,
      duration_ms: Math.round(performance.now() - start),
    })
    const interval = recurring.get(job.type)
    if (interval) {
      await enqueue(db, job.type, job.payload, { runAt: new Date(Date.now() + interval) })
    }
  } catch (err) {
    await finishFail(db, job, err)
  }
}

export const startDispatcher = (db: Connection): (() => void) => {
  let stopped = false
  let inTick = false

  const tick = async () => {
    if (stopped || inTick) return
    inTick = true
    try {
      const jobs = await claim(db)
      if (jobs.length > 0) {
        await Promise.allSettled(jobs.map(j => runOne(db, j)))
      }
    } catch (err) {
      log.error("dispatcher tick failed", { err: err instanceof Error ? err.message : String(err) })
    } finally {
      inTick = false
    }
  }

  const reapTick = async () => {
    if (stopped) return
    try { await reapStuck(db) } catch (err) {
      log.error("reap stuck jobs failed", { err: err instanceof Error ? err.message : String(err) })
    }
    try { await sweepDone(db) } catch (err) {
      log.error("sweep done jobs failed", { err: err instanceof Error ? err.message : String(err) })
    }
  }

  const tickHandle = setInterval(() => { void tick() }, TICK_MS)
  const reapHandle = setInterval(() => { void reapTick() }, 60 * 1000)
  void tick()
  void reapTick()

  return () => {
    stopped = true
    clearInterval(tickHandle)
    clearInterval(reapHandle)
  }
}

// Recurring jobs need to actually exist in the queue once at boot.
// Idempotent: if one is already pending or running, this is a no-op.
export const seedRecurring = async (db: Connection): Promise<void> => {
  for (const type of recurring.keys()) {
    const existing = await db.one(
      from("jobs")
        .where(q => q("type").equals(type))
        .where(q => q("status").inList(["pending", "running"]))
        .select("id"),
    )
    if (!existing) await enqueue(db, type, {})
  }
}
