// Structured JSON line logger. Stdout = info+, stderr = warn+.
// Each line is one self-contained JSON object so log shippers (Loki,
// Datadog, etc.) can ingest without parsing rules.

type Level = "debug" | "info" | "warn" | "error"

const LEVEL_RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }
const envLevel = (process.env.LOG_LEVEL ?? "info").toLowerCase() as Level
const MIN_RANK = LEVEL_RANK[envLevel] ?? LEVEL_RANK.info

const emit = (level: Level, msg: string, fields?: Record<string, unknown>) => {
  if (LEVEL_RANK[level] < MIN_RANK) return
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...fields,
  })
  if (level === "warn" || level === "error") process.stderr.write(line + "\n")
  else process.stdout.write(line + "\n")
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit("error", msg, fields),
}

export const newRequestId = (): string => {
  // 16 hex chars is plenty for correlating requests within a process.
  // Crypto.randomUUID would be 36 — overkill for log correlation.
  const buf = new Uint8Array(8)
  crypto.getRandomValues(buf)
  let out = ""
  for (const b of buf) out += b.toString(16).padStart(2, "0")
  return out
}
