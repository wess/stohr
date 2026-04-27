import type { ApiClient } from "./api.ts"

export type Droplet = {
  id: number
  name: string
  status: string
  networks: { v4: Array<{ ip_address: string; type: string }> }
}

export const findDroplet = async (api: ApiClient, name: string): Promise<Droplet | null> => {
  const res = await api.request<{ droplets: Droplet[] }>("GET", "/droplets?per_page=200")
  return res.droplets.find(d => d.name === name) ?? null
}

export const createDroplet = async (
  api: ApiClient,
  input: {
    name: string
    region: string
    size: string
    image: string
    sshKeyIds: number[]
    userData: string
  },
): Promise<Droplet> => {
  const res = await api.request<{ droplet: Droplet }>("POST", "/droplets", {
    name: input.name,
    region: input.region,
    size: input.size,
    image: input.image,
    ssh_keys: input.sshKeyIds,
    user_data: input.userData,
    tags: ["stohr"],
    monitoring: true,
    ipv6: false,
  })
  return res.droplet
}

export const waitForActive = async (
  api: ApiClient,
  dropletId: number,
  timeoutMs = 300_000,
): Promise<Droplet> => {
  const start = Date.now()
  let lastStatus = ""
  while (Date.now() - start < timeoutMs) {
    const res = await api.request<{ droplet: Droplet }>("GET", `/droplets/${dropletId}`)
    const d = res.droplet
    if (d.status !== lastStatus) {
      const elapsed = Math.round((Date.now() - start) / 1000)
      console.log(`  [${elapsed}s] status: ${d.status}`)
      lastStatus = d.status
    }
    const ip = d.networks?.v4?.find(n => n.type === "public")?.ip_address
    if (d.status === "active" && ip) return d
    await new Promise(r => setTimeout(r, 5000))
  }
  throw new Error("Droplet never reached active state")
}

export const ipFor = (d: Droplet): string => {
  const v4 = d.networks?.v4?.find(n => n.type === "public")
  if (!v4) throw new Error("No public IPv4 on droplet")
  return v4.ip_address
}
