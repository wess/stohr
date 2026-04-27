import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { createHash } from "node:crypto"
import { join } from "node:path"
import type { ApiClient } from "./api.ts"

type SshKey = { id: number; name: string; fingerprint: string; public_key: string }

const fingerprintFor = (publicKey: string): string => {
  const parts = publicKey.trim().split(/\s+/)
  const b64 = parts[1]
  if (!b64) throw new Error("Malformed public key (no base64 segment)")
  const bytes = Buffer.from(b64, "base64")
  const md5 = createHash("md5").update(bytes).digest("hex")
  return md5.match(/.{2}/g)!.join(":")
}

const findKeyFile = (preferred?: string): string | null => {
  if (preferred && existsSync(preferred)) return preferred
  for (const c of [".ssh/id_ed25519.pub", ".ssh/id_rsa.pub"]) {
    const p = join(homedir(), c)
    if (existsSync(p)) return p
  }
  return null
}

export const ensureSshKey = async (
  api: ApiClient,
  preferredFile?: string,
): Promise<{ id: number; fingerprint: string; path: string }> => {
  const path = findKeyFile(preferredFile)
  if (!path) {
    throw new Error(
      "No SSH public key found. Pass --ssh-pub-key=/path/to/key.pub or generate one: ssh-keygen -t ed25519",
    )
  }
  const publicKey = readFileSync(path, "utf8").trim()
  const fp = fingerprintFor(publicKey)

  const res = await api.request<{ ssh_keys: SshKey[] }>("GET", "/account/keys?per_page=200")
  const existing = res.ssh_keys.find(k => k.fingerprint === fp)
  if (existing) return { id: existing.id, fingerprint: existing.fingerprint, path }

  const created = await api.request<{ ssh_key: SshKey }>("POST", "/account/keys", {
    name: `stohr-${new Date().toISOString().slice(0, 10)}`,
    public_key: publicKey,
  })
  return { id: created.ssh_key.id, fingerprint: created.ssh_key.fingerprint, path }
}
