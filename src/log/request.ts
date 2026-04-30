import { log, newRequestId } from "./index.ts"

// Wraps a fetch handler so every request gets:
//   - x-request-id response header (echoed if the client sent one)
//   - one JSON access log line on completion with method, path, status, duration
// Stash the id on the request so downstream code can include it in their own logs.

const SENSITIVE_PATH = (path: string): boolean =>
  path.startsWith("/auth/") || path === "/login" || path === "/signup" ||
  path.startsWith("/oauth/") || path.includes("/password") ||
  path.includes("/mfa") || path.includes("/passkey")

export const withRequestLog = <S>(
  fetch: (req: Request, server?: S) => Response | Promise<Response>,
): ((req: Request, server?: S) => Promise<Response>) =>
  async (req, server) => {
    const incoming = req.headers.get("x-request-id")
    const id = incoming && incoming.length <= 64 ? incoming : newRequestId()
    ;(req as { requestId?: string }).requestId = id

    const start = performance.now()
    const url = new URL(req.url)
    let res: Response
    try {
      res = await fetch(req, server)
    } catch (err) {
      log.error("request failed", {
        request_id: id,
        method: req.method,
        path: url.pathname,
        err: err instanceof Error ? err.message : String(err),
      })
      throw err
    }

    const ms = Math.round(performance.now() - start)
    if (!res.headers.has("x-request-id")) res.headers.set("x-request-id", id)

    // Skip access logs for /healthz + /readyz to avoid drowning the log
    // stream when running behind a load balancer that polls them.
    if (url.pathname !== "/healthz" && url.pathname !== "/readyz") {
      log.info("http", {
        request_id: id,
        method: req.method,
        path: SENSITIVE_PATH(url.pathname) ? url.pathname : url.pathname + (url.search || ""),
        status: res.status,
        duration_ms: ms,
      })
    }
    return res
  }
