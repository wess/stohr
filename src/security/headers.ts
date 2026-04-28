const HEADERS: Record<string, string> = {
  "strict-transport-security": "max-age=63072000; includeSubDomains; preload",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-site",
}

export const withSecurityHeaders = (
  fetch: (req: Request) => Response | Promise<Response>,
): ((req: Request) => Promise<Response>) =>
  async (req) => {
    const res = await fetch(req)
    for (const [k, v] of Object.entries(HEADERS)) {
      if (!res.headers.has(k)) res.headers.set(k, v)
    }
    return res
  }
