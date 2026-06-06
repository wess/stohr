// Zero-dependency structured JSON logger. One line per event:
// {"ts":"…","level":"info","context":"…","msg":"…",...meta}. Meta keys whose
// name looks like a credential (password/secret/key/token/authorization) are
// redacted recursively before serialization, so accidentally logging a config
// object or request header bag never leaks a secret into stdout/your log sink.
//
// LOG_LEVEL (default "info") gates output: debug < info < warn < error. Set
// LOG_LEVEL=debug for verbose, LOG_LEVEL=error to quiet everything but errors.

export type LogLevel = "debug" | "info" | "warn" | "error"

const LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
}

const parseLevel = (raw: string | undefined): LogLevel => {
  const v = (raw ?? "").trim().toLowerCase()
  if (v === "debug" || v === "info" || v === "warn" || v === "error") return v
  return "info"
}

// Read once at module load. The process restarts to pick up a new LOG_LEVEL,
// matching how every other env-driven knob in this codebase behaves.
const threshold = LEVELS[parseLevel(process.env.LOG_LEVEL)]

const REDACT_RE = /password|secret|key|token|authorization/i
const REDACTED = "[redacted]"

// Recursively copy meta, masking any key that matches REDACT_RE. Arrays are
// walked element-wise; cyclic refs are broken with a seen-set so a self-
// referential object can never wedge the logger. Non-plain values pass through.
const redact = (value: unknown, seen: WeakSet<object>): unknown => {
  if (value === null || typeof value !== "object") return value
  if (seen.has(value as object)) return "[circular]"
  seen.add(value as object)
  if (Array.isArray(value)) return value.map(v => redact(v, seen))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = REDACT_RE.test(k) ? REDACTED : redact(v, seen)
  }
  return out
}

export const log = (level: LogLevel, context: string, msg: string, meta?: Record<string, unknown>): void => {
  if (LEVELS[level] < threshold) return
  const base: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    context,
    msg,
  }
  if (meta) {
    const safe = redact(meta, new WeakSet()) as Record<string, unknown>
    for (const [k, v] of Object.entries(safe)) {
      // Never let meta clobber the reserved envelope fields.
      if (k === "ts" || k === "level" || k === "context" || k === "msg") continue
      base[k] = v
    }
  }
  const line = JSON.stringify(base)
  if (level === "error") console.error(line)
  else if (level === "warn") console.warn(line)
  else console.log(line)
}

export const debug = (context: string, msg: string, meta?: Record<string, unknown>) => log("debug", context, msg, meta)
export const info = (context: string, msg: string, meta?: Record<string, unknown>) => log("info", context, msg, meta)
export const warn = (context: string, msg: string, meta?: Record<string, unknown>) => log("warn", context, msg, meta)
export const error = (context: string, msg: string, meta?: Record<string, unknown>) => log("error", context, msg, meta)
