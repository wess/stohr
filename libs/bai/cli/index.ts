#!/usr/bin/env bun
import { listCmd } from "./list.ts"
import { pullCmd } from "./pull.ts"

const [, , cmd, ...rest] = process.argv

const usage = () => {
  process.stdout.write(
    [
      "bai — in-process LLM inference",
      "",
      "Usage:",
      "  bai pull <preset>     download a model preset into the cache",
      "  bai list              list available presets and download status",
      "",
      "Models live under $BAI_CACHE_DIR or ~/.cache/bai.",
      "",
    ].join("\n"),
  )
}

const main = async () => {
  switch (cmd) {
    case "pull":
      await pullCmd(rest)
      return
    case "list":
      await listCmd(rest)
      return
    case "help":
    case "-h":
    case "--help":
    case undefined:
      usage()
      return
    default:
      process.stderr.write(`bai: unknown command '${cmd}'\n\n`)
      usage()
      process.exit(2)
  }
}

main().catch((err) => {
  process.stderr.write(`bai: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
