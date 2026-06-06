// Minimal JSON-RPC 2.0 helpers for the MCP transport. We accept a request
// object, dispatch to a handler, and return either a result or an error
// envelope. Notifications (no `id`) get no response (spec).

export type JsonRpcId = string | number | null

export type JsonRpcRequest = {
  jsonrpc: "2.0"
  id?: JsonRpcId
  method: string
  params?: unknown
}

export type JsonRpcSuccess = {
  jsonrpc: "2.0"
  id: JsonRpcId
  result: unknown
}

export type JsonRpcError = {
  jsonrpc: "2.0"
  id: JsonRpcId
  error: { code: number; message: string; data?: unknown }
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcError

export const ERR_PARSE = -32700
export const ERR_INVALID_REQUEST = -32600
export const ERR_METHOD_NOT_FOUND = -32601
export const ERR_INVALID_PARAMS = -32602
export const ERR_INTERNAL = -32603

export const ok = (id: JsonRpcId, result: unknown): JsonRpcSuccess => ({
  jsonrpc: "2.0",
  id,
  result,
})

export const fail = (id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcError => ({
  jsonrpc: "2.0",
  id,
  error: data === undefined ? { code, message } : { code, message, data },
})

export const isRequest = (v: unknown): v is JsonRpcRequest =>
  typeof v === "object" &&
  v !== null &&
  (v as JsonRpcRequest).jsonrpc === "2.0" &&
  typeof (v as JsonRpcRequest).method === "string"
