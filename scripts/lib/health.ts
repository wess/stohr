// Polls /healthz until 200 or timeout. Used by setup + update to confirm
// the API booted cleanly after `docker compose up`.

import { step } from "./run.ts"

export const waitForHealth = async (
  url: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> => {
  const timeout = opts.timeoutMs ?? 60_000
  const interval = opts.intervalMs ?? 1_000
  const start = Date.now()
  step(`waiting for ${url} to become healthy (timeout ${Math.round(timeout / 1000)}s)`)
  while (Date.now() - start < timeout) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2_000) })
      if (res.ok) {
        const elapsed = Math.round((Date.now() - start) / 1000)
        step(`healthy after ${elapsed}s`)
        return
      }
    } catch { /* retry */ }
    await new Promise(r => setTimeout(r, interval))
  }
  throw new Error(`api did not become healthy within ${timeout}ms — check \`docker compose logs api\``)
}
