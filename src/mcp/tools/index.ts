// Tool registry. Each tool declares an MCP-style JSON Schema for input plus a
// handler. The category lets the dispatcher gate by per-tool admin toggles
// (mcp_tool_read, mcp_tool_write, mcp_tool_delete, mcp_tool_share) at call
// time, so flipping a toggle in admin takes effect without restart.

import type { Connection } from "@atlas/db"
import type { StorageHandle } from "../../storage/index.ts"
import { readTools } from "./read.ts"
import { shareTools } from "./share.ts"
import { trashTools } from "./trash.ts"
import { writeTools } from "./write.ts"

export type ToolCategory = "read" | "write" | "delete" | "share"

export type ToolContext = {
  db: Connection
  store: StorageHandle
  userId: number
  // The advertised public URL of this Stohr instance — used to mint share links.
  appUrl: string
}

export type ToolContent = { type: "text"; text: string } | { type: "json"; json: unknown }

export type ToolResult = {
  content: ToolContent[]
  isError?: boolean
}

export type Tool = {
  name: string
  description: string
  category: ToolCategory
  inputSchema: {
    type: "object"
    properties: Record<string, unknown>
    required?: string[]
  }
  handler: (ctx: ToolContext, args: Record<string, unknown>) => Promise<ToolResult>
}

export const buildToolset = (): Tool[] => [...readTools(), ...writeTools(), ...trashTools(), ...shareTools()]

export const findTool = (tools: Tool[], name: string): Tool | undefined => tools.find(t => t.name === name)

// JSON-friendly text helper — many AI clients render text/* content
// straight; structured JSON gets stringified with indentation for readability.
export const asText = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
})

export const asError = (message: string): ToolResult => ({
  content: [{ type: "text", text: message }],
  isError: true,
})
