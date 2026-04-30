// Tiny .env parser — reads KEY=VALUE lines, ignores comments. We don't
// pull in dotenv because Bun already loads .env automatically; this is
// just for scripts that need to inspect what's set in the file (e.g.
// "is AI_EMBED_MODEL configured?") before invoking docker.

import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

export const envFilePath = (): string => resolve(process.cwd(), ".env")

export const readEnvFile = (path = envFilePath()): Record<string, string> => {
  if (!existsSync(path)) return {}
  const out: Record<string, string> = {}
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const m = trimmed.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (m && m[1]) {
      let v = m[2] ?? ""
      // Strip a single layer of surrounding quotes for convenience.
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1)
      }
      out[m[1]] = v
    }
  }
  return out
}
