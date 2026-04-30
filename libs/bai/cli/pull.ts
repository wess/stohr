import { existsSync } from "node:fs"
import { listPresets, resolvePreset } from "../models/registry.ts"
import { modelsCacheDir } from "../util/cache.ts"
import { download, hfDest, hfUrl } from "../util/download.ts"

const fmtBytes = (n: number): string => {
  if (n < 1024) return `${n}B`
  const units = ["KB", "MB", "GB"]
  let v = n / 1024
  for (const u of units) {
    if (v < 1024) return `${v.toFixed(1)}${u}`
    v /= 1024
  }
  return `${v.toFixed(1)}TB`
}

const renderProgress = (label: string) => {
  let lastPct = -1
  return (done: number, total: number | null) => {
    if (total === null) {
      process.stdout.write(`\r${label} ${fmtBytes(done)}…`)
      return
    }
    const pct = Math.floor((done / total) * 100)
    if (pct === lastPct) return
    lastPct = pct
    const bar = "█".repeat(Math.floor(pct / 2.5)) + "·".repeat(40 - Math.floor(pct / 2.5))
    process.stdout.write(`\r${label} [${bar}] ${pct}% (${fmtBytes(done)} / ${fmtBytes(total)})`)
  }
}

export const pullCmd = async (args: readonly string[]): Promise<void> => {
  if (args.length === 0) {
    process.stderr.write("usage: bai pull <preset>\n\nKnown presets:\n")
    for (const p of listPresets()) {
      process.stderr.write(`  ${p.id.padEnd(28)} ${p.kind.padEnd(6)} ${fmtBytes(p.sizeMb * 1024 * 1024)}\n`)
    }
    process.exit(2)
  }

  for (const id of args) {
    const preset = resolvePreset(id)
    if (!preset) {
      process.stderr.write(`bai: unknown preset '${id}'. Run \`bai list\` for choices.\n`)
      process.exit(2)
    }

    const dest = hfDest(modelsCacheDir(), preset.cacheName)
    if (existsSync(dest)) {
      process.stdout.write(`already cached: ${preset.id} → ${dest}\n`)
      continue
    }

    const url = hfUrl(preset.repo, preset.file)
    process.stdout.write(`pulling ${preset.id} (${fmtBytes(preset.sizeMb * 1024 * 1024)})\n`)
    await download({
      url,
      destPath: dest,
      resume: true,
      onProgress: renderProgress(`  ${preset.id}`),
    })
    process.stdout.write(`\n  → ${dest}\n`)
  }
}
