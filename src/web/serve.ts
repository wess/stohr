import index from "./index.html"

const API = process.env.API_URL ?? "http://localhost:3000"
const PORT = Number(process.env.WEB_PORT ?? 3001)

Bun.serve({
  port: PORT,
  routes: {
    "/": index,
    "/s/:token": index,
    "/app/*": index,
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
  development: {
    hmr: true,
    console: true,
  },
})

console.log(`[stohr] web on http://localhost:${PORT}`)
