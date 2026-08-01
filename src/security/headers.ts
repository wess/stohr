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
// Built as a function so the web server can pass the sha256 of the inline
// theme-init script in index.html. That script has to run before first paint
// to avoid a light/dark flash, so it can't move into the bundle — a hash
// allowlists exactly that one snippet without opening the door to
// 'unsafe-inline'.
const cspProd = (scriptHashes: string[]): string =>
  "default-src 'self'; " +
  `script-src 'self'${scriptHashes.map(h => ` '${h}'`).join("")}; ` +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob: https:; " +
  "font-src 'self' data:; " +
  "connect-src 'self'; " +
  "media-src 'self' blob:; " +
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
  "object-src 'none'; " +
  "base-uri 'self'; " +
  "form-action 'self'; " +
  "frame-ancestors 'none'"

// The document itself needs these as much as the API does — arguably more,
// since the HTML is what the browser actually executes. The web server pulls
// this in so the SPA isn't served bare.
export const securityHeaders = (scriptHashes: string[] = []): Record<string, string> => ({
  "strict-transport-security": "max-age=63072000; includeSubDomains; preload",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-site",
  "content-security-policy": isDev ? CSP_DEV : cspProd(scriptHashes),
})

const HEADERS = securityHeaders()

// Bun.serve passes a `server` argument to the fetch handler that exposes the
// raw socket peer via `server.requestIP(req)`. We stash that onto the request
// so downstream code (rate-limit buckets, audit logs) can read the *real*
// peer rather than trusting whatever a client puts in X-Forwarded-For.
type BunServer = { requestIP?: (req: Request) => { address: string } | null }

export const withSecurityHeaders =
  (fetch: (req: Request) => Response | Promise<Response>): ((req: Request, server?: BunServer) => Promise<Response>) =>
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
