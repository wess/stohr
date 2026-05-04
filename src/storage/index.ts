import { randomBytes } from "node:crypto"
import { createS3Driver, type S3Config } from "./s3/index.ts"
import { createLocalDriver, type LocalConfig } from "./local/index.ts"

export type StorageDriver = {
  put(key: string, body: Blob | Uint8Array | string, contentType?: string): Promise<void>
  get(key: string): Promise<Response>
  drop(key: string): Promise<void>
}

export type StorageHandle = StorageDriver

export type StorageConfig =
  | ({ driver: "s3" } & S3Config)
  | ({ driver: "local" } & LocalConfig)

export const createStorage = (cfg: StorageConfig): StorageHandle => {
  if (cfg.driver === "s3") return createS3Driver(cfg)
  if (cfg.driver === "local") return createLocalDriver(cfg)
  throw new Error(`Unknown storage driver: ${(cfg as { driver: string }).driver}`)
}

export const put = (h: StorageHandle, key: string, body: Blob | Uint8Array | string, contentType?: string) =>
  h.put(key, body, contentType)

export const fetchObject = (h: StorageHandle, key: string) => h.get(key)

export const drop = (h: StorageHandle, key: string) => h.drop(key)

export const makeKey = (userId: number, name: string) => {
  const stamp = Date.now().toString(36)
  // 8 hex chars (32 bits) of cryptographic randomness — keys aren't capabilities,
  // but using crypto-grade randomness avoids ever leaking RNG state.
  const rand = randomBytes(4).toString("hex")
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, "_")
  return `u${userId}/${stamp}${rand}/${safe}`
}
