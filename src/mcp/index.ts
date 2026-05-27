import type { Connection } from "@atlas/db"
import { get, json, parseJson, pipeline, post } from "@atlas/server"
import { requireAuth } from "../auth/guard.ts"
import { ownerOnly } from "../security/owner.ts"
import type { StorageHandle } from "../storage/index.ts"
import { mcpEnabled, mcpToolEnabled } from "../settings/index.ts"
import {
  ERR_INTERNAL,
  ERR_INVALID_PARAMS,
  ERR_INVALID_REQUEST,
  ERR_METHOD_NOT_FOUND,
  fail,
  isRequest,
  ok,
  type JsonRpcId,
  type JsonRpcResponse,
} from "./jsonrpc.ts"
import {
  asError,
  buildToolset,
  findTool,
  type Tool,
  type ToolCategory,
  type ToolContext,
} from "./tools/index.ts"

const PROTOCOL_VERSION = "2024-11-05"
const SERVER_NAME = "stohr-mcp"
const SERVER_VERSION = "0.1.0"

const authId = (c: any) => (c.assigns.auth as { id: number }).id

// We re-check per-tool category gating at tools/list time so disabled tools
// don't even appear in the catalog. That's friendlier for AI clients — they
// learn the surface upfront and never try to call something that will fail.
const filterEnabledTools = async (db: Connection, all: Tool[]): Promise<Tool[]> => {
  const cats = new Set<ToolCategory>()
  if (await mcpToolEnabled(db, "read")) cats.add("read")
  if (await mcpToolEnabled(db, "write")) cats.add("write")
  if (await mcpToolEnabled(db, "delete")) cats.add("delete")
  if (await mcpToolEnabled(db, "share")) cats.add("share")
  return all.filter(t => cats.has(t.category))
}

const dispatch = async (
  req: { id: JsonRpcId; method: string; params: any },
  ctx: ToolContext,
  allTools: Tool[],
): Promise<JsonRpcResponse | null> => {
  const { id, method, params } = req

  if (method === "initialize") {
    return ok(id, {
      protocolVersion: PROTOCOL_VERSION,
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      capabilities: { tools: { listChanged: false } },
    })
  }

  if (method === "ping") return ok(id, {})

  // Notifications (no `id`) get no response per JSON-RPC. The init/cancel/etc
  // notifications fall through here.
  if (method.startsWith("notifications/")) return null

  if (method === "tools/list") {
    const tools = await filterEnabledTools(ctx.db, allTools)
    return ok(id, {
      tools: tools.map(t => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    })
  }

  if (method === "tools/call") {
    if (!params || typeof params.name !== "string") {
      return fail(id, ERR_INVALID_PARAMS, "tools/call requires { name, arguments? }")
    }
    const tool = findTool(allTools, params.name)
    if (!tool) {
      return fail(id, ERR_METHOD_NOT_FOUND, `Unknown tool: ${params.name}`)
    }
    // Re-check the per-tool admin toggle at call time. A tool that was advertised
    // at tools/list might have been disabled in the meantime.
    const allowed = await mcpToolEnabled(ctx.db, tool.category)
    if (!allowed) {
      return ok(id, asError(`Tool '${tool.name}' is disabled by the instance owner (${tool.category} tools are off).`))
    }
    try {
      const result = await tool.handler(ctx, (params.arguments ?? {}) as Record<string, unknown>)
      return ok(id, result)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return ok(id, asError(`Tool failed: ${msg}`))
    }
  }

  return fail(id, ERR_METHOD_NOT_FOUND, `Method not found: ${method}`)
}

export const mcpRoutes = (db: Connection, secret: string, store: StorageHandle, appUrl: string) => {
  const guard = pipeline(requireAuth({ secret, db }), parseJson)
  const tools = buildToolset()

  return [
    // Discovery endpoint. AI clients (or owners) hit this unauthenticated to
    // see whether MCP is enabled and what categories are exposed.
    get("/mcp", async (c) => {
      const enabled = await mcpEnabled(db)
      const cats = {
        read: await mcpToolEnabled(db, "read"),
        write: await mcpToolEnabled(db, "write"),
        delete: await mcpToolEnabled(db, "delete"),
        share: await mcpToolEnabled(db, "share"),
      }
      return json(c, 200, {
        enabled,
        endpoint: `${appUrl.replace(/\/$/, "")}/mcp`,
        protocol_version: PROTOCOL_VERSION,
        server: { name: SERVER_NAME, version: SERVER_VERSION },
        categories: cats,
        auth: "Bearer (PAT or OAuth access token) on POST /mcp",
      })
    }),

    post("/mcp", guard(async (c) => {
      if (!(await mcpEnabled(db))) {
        return json(c, 503, { error: "MCP is disabled on this instance" })
      }

      const body = c.body as unknown
      // Single request or batch (array). Notifications (no id) yield no
      // entry in the response array; if the whole batch is notifications
      // we return an empty 204.
      const requests = Array.isArray(body) ? body : [body]
      if (requests.length === 0) {
        return json(c, 400, fail(null, ERR_INVALID_REQUEST, "Empty batch"))
      }

      const userId = authId(c)
      const ctx: ToolContext = { db, store, userId, appUrl }

      const responses: JsonRpcResponse[] = []
      for (const raw of requests) {
        if (!isRequest(raw)) {
          responses.push(fail(null, ERR_INVALID_REQUEST, "Invalid JSON-RPC request"))
          continue
        }
        const idOrNull: JsonRpcId = raw.id === undefined ? null : raw.id
        try {
          const res = await dispatch({ id: idOrNull, method: raw.method, params: raw.params }, ctx, tools)
          // Notifications produce null — skip them in the response.
          if (res !== null) responses.push(res)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          responses.push(fail(idOrNull, ERR_INTERNAL, msg))
        }
      }

      if (Array.isArray(body)) {
        if (responses.length === 0) {
          return json(c, 204, {})
        }
        return json(c, 200, responses)
      }
      return json(c, 200, responses[0])
    })),
  ]
}

// Owner-facing preview: returns the catalog of tools, separated into
// advertised (currently enabled) vs hidden (gated off by a per-tool toggle).
// Lets the admin UI show exactly what an AI client would see without making
// the owner copy a PAT and run a JSON-RPC client.
export const adminMcpRoutes = (db: Connection, secret: string, appUrl: string) => {
  const tools = buildToolset()
  const ownerCheck = ownerOnly(db)
  const guard = pipeline(requireAuth({ secret, db, noOAuth: true }), ownerCheck)
  return [
    get("/admin/mcp/preview", guard(async (c) => {
      const enabled = await mcpEnabled(db)
      const advertised = await filterEnabledTools(db, tools)
      const advertisedNames = new Set(advertised.map(t => t.name))
      return json(c, 200, {
        enabled,
        endpoint: `${appUrl.replace(/\/$/, "")}/mcp`,
        advertised_tools: advertised.map(t => ({ name: t.name, category: t.category, description: t.description })),
        hidden_tools: tools.filter(t => !advertisedNames.has(t.name)).map(t => ({ name: t.name, category: t.category })),
      })
    })),
  ]
}
