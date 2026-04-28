import { $ } from "bun"

const CONFIG_DIR = `${process.env.HOME}/.config/stohrshot`
const CONFIG_PATH = `${CONFIG_DIR}/config.json`

export type Config = {
  serverUrl: string        // Stohr API base, e.g. "https://stohr.example.com/api"
  clientId: string | null  // OAuth client_id registered on the server
  redirectUri: string      // Custom-scheme redirect (matches butter.yaml urlSchemes)
}

const DEFAULTS: Config = {
  serverUrl: "https://stohr.io/api",
  clientId: null,
  redirectUri: "stohrshot://oauth/callback",
}

export const loadConfig = async (): Promise<Config> => {
  try {
    const text = await Bun.file(CONFIG_PATH).text()
    return { ...DEFAULTS, ...(JSON.parse(text) as Partial<Config>) }
  } catch {
    return { ...DEFAULTS }
  }
}

export const saveConfig = async (cfg: Config): Promise<void> => {
  await $`mkdir -p ${CONFIG_DIR}`.quiet()
  await Bun.write(CONFIG_PATH, JSON.stringify(cfg, null, 2))
}
