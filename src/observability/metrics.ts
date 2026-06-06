// Prometheus /metrics endpoint. Zero-dependency, in-memory instrumentation of
// the request pipeline. NOTE: all metrics are per-process and held in memory —
// they reset to zero on every restart and are not shared across replicas. A
// scraper should treat counter resets as expected (Prometheus handles this via
// rate() reset detection). For a multi-replica deployment, scrape each pod.
//
//   GET /metrics — public, unauthenticated, "text/plain; version=0.0.4".
//                  Exposes:
//                    http_requests_total{method,status}   (counter)
//                    http_request_duration_ms{...,le}     (histogram)
//
// withMetrics(handler) wraps the router fetch: it times each request and records
// the method + final status into the counter and latency histogram.

import { get, putHeader, text } from "@atlas/server"

// http_requests_total — keyed by "method status" so each label combo is its
// own counter line.
const requestCounts = new Map<string, number>()

// http_request_duration_ms histogram. Buckets are cumulative ("le" = less than
// or equal). 5ms..5000ms covers the realistic latency band for this API.
const LATENCY_BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000]

// Per-(method,status) histogram state: cumulative bucket hit counts plus the
// running sum and total count Prometheus needs for *_sum and *_count.
type Histogram = {
  buckets: number[]
  sum: number
  count: number
}
const latency = new Map<string, Histogram>()

const histogramFor = (key: string): Histogram => {
  let h = latency.get(key)
  if (!h) {
    h = { buckets: LATENCY_BUCKETS.map(() => 0), sum: 0, count: 0 }
    latency.set(key, h)
  }
  return h
}

// Normalize the method so a flood of odd verbs can't blow up the label space.
const normMethod = (method: string): string => method.toUpperCase()

export const recordRequest = (method: string, status: number, ms: number): void => {
  const m = normMethod(method)
  const s = String(status)
  const key = `${m} ${s}`

  requestCounts.set(key, (requestCounts.get(key) ?? 0) + 1)

  const h = histogramFor(key)
  h.sum += ms
  h.count += 1
  for (let i = 0; i < LATENCY_BUCKETS.length; i++) {
    if (ms <= LATENCY_BUCKETS[i]) h.buckets[i] += 1
  }
}

// Prometheus exposition format requires label values to escape backslash,
// double-quote, and newline.
const escapeLabel = (v: string): string => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")

const splitKey = (key: string): { method: string; status: string } => {
  const sp = key.lastIndexOf(" ")
  return { method: key.slice(0, sp), status: key.slice(sp + 1) }
}

export const renderMetrics = (): string => {
  const lines: string[] = []

  lines.push("# HELP http_requests_total Total HTTP requests handled, by method and status.")
  lines.push("# TYPE http_requests_total counter")
  for (const [key, count] of requestCounts) {
    const { method, status } = splitKey(key)
    lines.push(`http_requests_total{method="${escapeLabel(method)}",status="${escapeLabel(status)}"} ${count}`)
  }

  lines.push("# HELP http_request_duration_ms HTTP request latency in milliseconds, by method and status.")
  lines.push("# TYPE http_request_duration_ms histogram")
  for (const [key, h] of latency) {
    const { method, status } = splitKey(key)
    const m = escapeLabel(method)
    const s = escapeLabel(status)
    let cumulative = 0
    for (let i = 0; i < LATENCY_BUCKETS.length; i++) {
      cumulative = h.buckets[i]
      lines.push(
        `http_request_duration_ms_bucket{method="${m}",status="${s}",le="${LATENCY_BUCKETS[i]}"} ${cumulative}`,
      )
    }
    lines.push(`http_request_duration_ms_bucket{method="${m}",status="${s}",le="+Inf"} ${h.count}`)
    lines.push(`http_request_duration_ms_sum{method="${m}",status="${s}"} ${h.sum}`)
    lines.push(`http_request_duration_ms_count{method="${m}",status="${s}"} ${h.count}`)
  }

  // Exposition format wants a trailing newline.
  return `${lines.join("\n")}\n`
}

// Public, unauthenticated metrics route. Mounted alongside healthRoutes in the
// server composition root.
export const metricsRoutes = () => [
  get("/metrics", async c => putHeader(text(c, 200, renderMetrics()), "content-type", "text/plain; version=0.0.4")),
]

// Wraps the request handler: times the request, records method+status+latency.
// Errors thrown by the inner handler are recorded as status 500 and re-thrown
// so the existing error path is unchanged. Extra args (Bun's `server`, used by
// withSecurityHeaders for peer-IP detection) are forwarded untouched.
export const withMetrics = <A extends unknown[]>(
  handler: (req: Request, ...rest: A) => Response | Promise<Response>,
) => {
  return async (req: Request, ...rest: A): Promise<Response> => {
    const start = performance.now()
    try {
      const res = await handler(req, ...rest)
      recordRequest(req.method, res.status, performance.now() - start)
      return res
    } catch (err) {
      recordRequest(req.method, 500, performance.now() - start)
      throw err
    }
  }
}
