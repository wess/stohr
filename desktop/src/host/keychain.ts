import { $ } from "bun"

const SERVICE = "io.stohr.shot"

/**
 * Tiny wrapper over the macOS `security` CLI. Linux/Windows fall back to
 * unprotected disk storage at ~/.config/stohrshot/secrets.json — a TODO until
 * we wire libsecret / DPAPI directly. This is good enough for v1 on macOS.
 */

const isMac = process.platform === "darwin"
const fallbackPath = `${process.env.HOME}/.config/stohrshot/secrets.json`

const ensureFallbackDir = async (): Promise<void> => {
  await $`mkdir -p ${`${process.env.HOME}/.config/stohrshot`}`.quiet()
}

const readFallback = async (): Promise<Record<string, string>> => {
  try {
    const text = await Bun.file(fallbackPath).text()
    return JSON.parse(text) as Record<string, string>
  } catch {
    return {}
  }
}

const writeFallback = async (map: Record<string, string>): Promise<void> => {
  await ensureFallbackDir()
  await Bun.write(fallbackPath, JSON.stringify(map, null, 2))
  if (isMac) await $`chmod 600 ${fallbackPath}`.quiet().nothrow()
}

export const setSecret = async (key: string, value: string): Promise<void> => {
  if (isMac) {
    // -U updates if already present.
    await $`security add-generic-password -U -s ${SERVICE} -a ${key} -w ${value}`.quiet()
    return
  }
  const map = await readFallback()
  map[key] = value
  await writeFallback(map)
}

export const getSecret = async (key: string): Promise<string | null> => {
  if (isMac) {
    const proc = await $`security find-generic-password -s ${SERVICE} -a ${key} -w`.nothrow().quiet()
    if (proc.exitCode !== 0) return null
    return proc.stdout.toString().trim() || null
  }
  const map = await readFallback()
  return map[key] ?? null
}

export const deleteSecret = async (key: string): Promise<void> => {
  if (isMac) {
    await $`security delete-generic-password -s ${SERVICE} -a ${key}`.nothrow().quiet()
    return
  }
  const map = await readFallback()
  delete map[key]
  await writeFallback(map)
}
