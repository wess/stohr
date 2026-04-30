#!/usr/bin/env bun
// Pull a bai model into the named docker volume `baimodels`. Idempotent —
// `bai pull` skips the download if the file is already in the cache.
//
// Usage:
//   bun run ai:pull                 # uses AI_EMBED_MODEL from .env
//   bun run ai:pull <preset-id>     # explicit override

import { readEnvFile } from "../lib/env.ts"
import { die, run, step } from "../lib/run.ts"

const main = () => {
  const [, , overrideId] = process.argv
  const env = readEnvFile()
  const id = overrideId ?? env.AI_EMBED_MODEL

  if (!id) {
    die("no model specified — pass an argument or set AI_EMBED_MODEL in .env")
  }

  step(`pulling bai model: ${id}`)
  run(["docker", "compose", "run", "--rm", "api", "bunx", "bai", "pull", id])
  step("done — model is in the baimodels volume")
}

main()
