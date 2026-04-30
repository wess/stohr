// Strict default headers. CSP is strict-by-default for production;
// development allows the Bun HMR websocket and inline runtime that bun build
// injects. Toggle via NODE_ENV.
const isDev = (process.env.NODE_ENV ?? "development") === "development"

// Production CSP: no inline scripts, no third-party origins, no framing.
//   - script-src 'self': blocks any injected <script src=evil.com>
//   - style-src adds 'unsafe-inline' because the SPA uses inline styles
//     (acceptable: style injection alone can't read the bearer token)
//   - img-src allows blob: for AuthedImage and data: for icons
//   - frame-ancestors 'none' duplicates X-Frame-Options for modern browsers
const CSP_PROD =
  "default-src 'self'; " +
  "script-src 'self'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob: https:; " +
  "font-src 'self' data:; " +
  "connect-src 'self'; " +
  "media-src 'self' blob:; " +
  // PDF preview renders via <iframe src=blob:…> using the browser's built-in
  // PDF viewer. Without this, the iframe falls back to default-src 'self' and
  // is blocked.
  "frame-src 'self' blob:; " +
  "object-src 'none'; " +
  "base-uri 'self'; " +
  "form-action 'self'; " +
  "frame-ancestors 'none'"

// Dev CSP: same shape, but allow ws:/http: for the Bun HMR runtime and
// 'unsafe-eval'+'unsafe-inline' for the dev bundler. Don't ship this.
const CSP_DEV =
  "default-src 'self'; " +
  "script-src 'self' 'unsafe-eval' 'unsafe-inline'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob: https:; " +
  "font-src 'self' data:; " +
  "connect-src 'self' ws: wss: http: https:; " +
  "media-src 'self' blob:; " +
  "frame-src 'self' blob:; " +
  "object-src 'none'; " +
  "base-uri 'self'; " +
  "form-action 'self'; " +
  "frame-ancestors 'none'"

const HEADERS: Record<string, string> = {
  "strict-transport-security": "max-age=63072000; includeSubDomains; preload",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-site",
  "content-security-policy": isDev ? CSP_DEV : CSP_PROD,
}

// Bun.serve passes a `server` argument to the fetch handler that exposes the
// raw socket peer via `server.requestIP(req)`. We stash that onto the request
// so downstream code (rate-limit buckets, audit logs) can read the *real*
// peer rather than trusting whatever a client puts in X-Forwarded-For.
type BunServer = { requestIP?: (req: Request) => { address: string } | null }

export const withSecurityHeaders = (
  fetch: (req: Request) => Response | Promise<Response>,
): ((req: Request, server?: BunServer) => Promise<Response>) =>
  async (req, server) => {
    if (server?.requestIP) {
      const peer = server.requestIP(req)
      if (peer?.address) {
        ;(req as { peerIp?: string }).peerIp = peer.address
      }
    }
    const res = await fetch(req)
    for (const [k, v] of Object.entries(HEADERS)) {
      if (!res.headers.has(k)) res.headers.set(k, v)
    }
    return res
  }
