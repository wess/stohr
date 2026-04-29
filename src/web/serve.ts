import index from "./index.html"

const API = process.env.API_URL ?? "http://localhost:3000"
const PORT = Number(process.env.WEB_PORT ?? 3001)

// Dev-only: HMR + verbose console in the browser. In production this MUST
// be false, otherwise Bun bundles the SPA with the dev JSX runtime
// (jsxDEV) but resolves React to the prod runtime that has no jsxDEV
// export — every component crashes at first render.
const isDev = (process.env.NODE_ENV ?? "development") === "development"

Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  maxRequestBodySize: Number.MAX_SAFE_INTEGER,
  idleTimeout: 0,
  routes: {
    "/": index,
    "/s/:token": index,
    "/signup": index,
    "/login": index,
    "/developers": index,
    "/app/*": index,
    "/p/:username/:folderId": index,
    "/oauth/authorize": index,
    "/pair": index,
    "/password/forgot": index,
    "/password/reset": index,
  },
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname.startsWith("/api/")) {
      const target = `${API}${url.pathname.replace("/api", "")}${url.search}`
      const res = await fetch(target, {
        method: req.method,
        headers: req.headers,
        body: req.body,
      })
      return new Response(res.body, { status: res.status, headers: res.headers })
    }
    return new Response("Not Found", { status: 404 })
  },
  development: isDev ? { hmr: true, console: true } : false,
})

console.log(`[stohr] web on http://localhost:${PORT}`)
