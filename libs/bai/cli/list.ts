import { existsSync } from "node:fs"
import { join } from "node:path"
import { listPresets } from "../models/registry.ts"
import { modelsCacheDir } from "../util/cache.ts"

const fmtMb = (n: number): string => n >= 1024 ? `${(n / 1024).toFixed(1)}GB` : `${n}MB`

export const listCmd = async (_args: readonly string[]): Promise<void> => {
  const dir = modelsCacheDir()
  const rows: Array<[string, string, string, string, string]> = []
  for (const p of listPresets()) {
    const path = join(dir, p.cacheName)
    const cached = existsSync(path) ? "yes" : "no"
    rows.push([p.id, p.kind, fmtMb(p.sizeMb), cached, p.notes])
  }
  const widths = [0, 0, 0, 0]
  for (const r of rows) {
    for (let i = 0; i < 4; i++) {
      const w = (r[i] as string).length
      if (w > (widths[i] as number)) widths[i] = w
    }
  }
  for (const r of rows) {
    process.stdout.write(
      `  ${r[0].padEnd(widths[0] as number)}  ` +
        `${r[1].padEnd(widths[1] as number)}  ` +
        `${r[2].padEnd(widths[2] as number)}  ` +
        `cached:${r[3].padEnd(widths[3] as number)}  ${r[4]}\n`,
    )
  }
  process.stdout.write(`\n  cache dir: ${dir}\n`)
}
