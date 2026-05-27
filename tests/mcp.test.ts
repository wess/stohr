import { createHash } from "node:crypto"
import { from } from "@atlas/db"
import { beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { db, truncateAll, TEST_SECRET } from "./setup.ts"
import { buildApp, callJson } from "./helpers/http.ts"

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex")

let app: ReturnType<typeof buildApp>

beforeAll(() => {
  app = buildApp(db, TEST_SECRET)
})

beforeEach(async () => {
  await truncateAll()
})

const signupOwner = async (): Promise<string> => {
  const res = await callJson(app, "/signup", {
    method: "POST",
    body: { name: "Owner", username: "owner", email: "owner@example.com", password: "password123" },
  })
  expect(res.status).toBe(201)
  expect(res.body.is_owner).toBe(true)
  return res.body.token as string
}

const rpc = async (token: string, method: string, params?: unknown, id: number = 1) => {
  return await callJson(app, "/mcp", {
    method: "POST",
    token,
    body: { jsonrpc: "2.0", id, method, params },
  })
}

describe("MCP server", () => {
  test("disabled by default — POST /mcp returns 503", async () => {
    const jwt = await signupOwner()
    const res = await rpc(jwt, "initialize")
    expect(res.status).toBe(503)
  })

  test("GET /mcp discovery is unauthenticated and reports state", async () => {
    const res = await callJson(app, "/mcp")
    expect(res.status).toBe(200)
    expect(res.body.enabled).toBe(false)
    expect(res.body.endpoint).toContain("/mcp")
    expect(res.body.categories).toEqual({ read: true, write: false, delete: false, share: false })
  })

  test("tools/list only advertises enabled categories", async () => {
    const jwt = await signupOwner()
    // Enable MCP. Read is on by default; write/delete/share remain off.
    await callJson(app, "/admin/settings", {
      method: "PATCH", token: jwt, body: { mcp_enabled: true },
    })

    const list = await rpc(jwt, "tools/list")
    expect(list.status).toBe(200)
    const names = list.body.result.tools.map((t: any) => t.name)
    expect(names).toContain("list_folders")
    expect(names).toContain("read_file")
    expect(names).not.toContain("create_folder")  // write off
    expect(names).not.toContain("trash_file")     // delete off
    expect(names).not.toContain("create_share")   // share off

    // Turn on write — now create_folder appears.
    await callJson(app, "/admin/settings", {
      method: "PATCH", token: jwt, body: { mcp_tool_write: true },
    })
    const list2 = await rpc(jwt, "tools/list", undefined, 2)
    const names2 = list2.body.result.tools.map((t: any) => t.name)
    expect(names2).toContain("create_folder")
  })

  test("tools/call respects per-category gate even if name is known", async () => {
    const jwt = await signupOwner()
    await callJson(app, "/admin/settings", { method: "PATCH", token: jwt, body: { mcp_enabled: true } })
    // write toggle is OFF — calling create_folder must return an error result.
    const call = await rpc(jwt, "tools/call", { name: "create_folder", arguments: { name: "test" } })
    expect(call.status).toBe(200)
    expect(call.body.result.isError).toBe(true)
    expect(call.body.result.content[0].text).toMatch(/disabled/i)
  })

  test("read tools work end-to-end with a PAT", async () => {
    const jwt = await signupOwner()
    await callJson(app, "/admin/settings", { method: "PATCH", token: jwt, body: { mcp_enabled: true } })

    // Mint a PAT and use it.
    const createPat = await callJson(app, "/me/apps", {
      method: "POST", token: jwt, body: { name: "mcp-client" },
    })
    const pat = createPat.body.token as string

    // Create a folder via the HTTP API so we have something to list.
    const folder = await callJson(app, "/folders", {
      method: "POST", token: jwt, body: { name: "Docs" },
    })
    expect(folder.status).toBe(201)

    const init = await rpc(pat, "initialize")
    expect(init.status).toBe(200)
    expect(init.body.result.protocolVersion).toBe("2024-11-05")

    const call = await rpc(pat, "tools/call", { name: "list_folders", arguments: {} })
    expect(call.status).toBe(200)
    const payload = JSON.parse(call.body.result.content[0].text)
    expect(payload).toHaveLength(1)
    expect(payload[0].name).toBe("Docs")
  })

  test("unknown tool returns method-not-found error", async () => {
    const jwt = await signupOwner()
    await callJson(app, "/admin/settings", { method: "PATCH", token: jwt, body: { mcp_enabled: true } })
    const res = await rpc(jwt, "tools/call", { name: "bogus", arguments: {} })
    expect(res.status).toBe(200)
    expect(res.body.error).toBeDefined()
    expect(res.body.error.code).toBe(-32601)
  })

  test("admin preview lists advertised vs hidden tools", async () => {
    const jwt = await signupOwner()
    await callJson(app, "/admin/settings", { method: "PATCH", token: jwt, body: { mcp_enabled: true } })
    const res = await callJson(app, "/admin/mcp/preview", { token: jwt })
    expect(res.status).toBe(200)
    expect(res.body.enabled).toBe(true)
    const adv = res.body.advertised_tools.map((t: any) => t.name)
    const hid = res.body.hidden_tools.map((t: any) => t.name)
    expect(adv).toContain("list_folders")
    expect(hid).toContain("create_folder")  // write category off
  })

  test("admin can CRUD external MCP servers", async () => {
    const jwt = await signupOwner()
    const create = await callJson(app, "/admin/mcp/servers", {
      method: "POST", token: jwt,
      body: { name: "Remote", url: "https://example.com/mcp", auth_token: "secret" },
    })
    expect(create.status).toBe(201)
    expect(create.body.has_auth_token).toBe(true)
    // Tokens are never echoed back.
    expect(create.body.auth_token).toBeUndefined()

    const list = await callJson(app, "/admin/mcp/servers", { token: jwt })
    expect(list.status).toBe(200)
    expect(list.body).toHaveLength(1)

    const update = await callJson(app, `/admin/mcp/servers/${create.body.id}`, {
      method: "PATCH", token: jwt, body: { enabled: false },
    })
    expect(update.status).toBe(200)
    expect(update.body.enabled).toBe(false)

    const del = await callJson(app, `/admin/mcp/servers/${create.body.id}`, {
      method: "DELETE", token: jwt,
    })
    expect(del.status).toBe(200)
  })

  test("non-owner cannot toggle MCP settings or manage servers", async () => {
    await signupOwner()
    // Second user needs an invite to sign up.
    const inviteToken = "inv-" + Math.random().toString(36).slice(2)
    await db.execute(from("invites").insert({ token_hash: sha256(inviteToken) }))
    const second = await callJson(app, "/signup", {
      method: "POST",
      body: { name: "Bob", username: "bob", email: "bob@example.com", password: "password123", invite_token: inviteToken },
    })
    expect(second.status).toBe(201)
    const jwt = second.body.token as string
    expect(Boolean(second.body.is_owner)).toBe(false)

    const toggle = await callJson(app, "/admin/settings", {
      method: "PATCH", token: jwt, body: { mcp_enabled: true },
    })
    expect(toggle.status).toBe(403)

    const create = await callJson(app, "/admin/mcp/servers", {
      method: "POST", token: jwt, body: { name: "x", url: "https://x" },
    })
    expect(create.status).toBe(403)
  })
})
