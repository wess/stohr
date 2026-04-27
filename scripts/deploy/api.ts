const BASE = "https://api.digitalocean.com/v2"

export type ApiClient = {
  request: <T = any>(method: string, path: string, body?: unknown) => Promise<T>
}

export const createApi = (token: string): ApiClient => ({
  request: async <T = any>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`DO API ${method} ${path} → ${res.status}: ${text}`)
    }
    return text ? JSON.parse(text) as T : ({} as T)
  },
})
