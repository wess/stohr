import { beforeAll, beforeEach, describe, expect, test } from "bun:test"
import type { App } from "./helpers/http.ts"
import { callJson } from "./helpers/http.ts"
import { callMultipart } from "./helpers/multipart.ts"
import { buildProtocolApp } from "./helpers/protocolapp.ts"
import { hostOf, ROOT, type Session, signupOwner, teamWithAdmin } from "./helpers/teams.ts"
import { db, TEST_SECRET, truncateAll } from "./setup.ts"

// Public links resolve on their owner's team host and nowhere else. On any
// other host the answer is the one an unknown link gets, so a host cannot be
// used to probe for links that live on another.

let app: App

beforeAll(() => {
  app = buildProtocolApp(db, TEST_SECRET)
})
beforeEach(async () => {
  await truncateAll()
})

const upload = async (host: string, token: string, name: string, body: string, folderId?: number) => {
  const res = await callMultipart(app, "/files", {
    token,
    host,
    fields: folderId ? { folder_id: String(folderId) } : {},
    files: [{ name, type: "text/plain", body }],
  })
  expect(res.status).toBe(201)
  return res.body[0].id as number
}

const share = async (host: string, token: string, fileId: number): Promise<string> => {
  const res = await callJson(app, "/shares", { method: "POST", host, token, body: { file_id: fileId, expires_in: 3600 } })
  expect(res.status).toBe(201)
  return res.body.token as string
}

const settings = (owner: Session, body: Record<string, boolean>) =>
  callJson(app, "/admin/settings", { method: "PATCH", host: ROOT, token: owner.token, body })

describe("/s/:token", () => {
  test("a tenant's share link downloads on the tenant host and is not found anywhere else", async () => {
    const owner = await signupOwner(app)
    const a = await teamWithAdmin(app, owner, "acme")
    const b = await teamWithAdmin(app, owner, "beta")
    const fileId = await upload(a.host, a.admin.token, "note.txt", "hello share")
    const token = await share(a.host, a.admin.token, fileId)

    const home = await callJson(app, `/s/${token}`, { host: a.host })
    expect(home.status).toBe(200)
    expect(home.body).toBe("hello share")
    expect((await callJson(app, `/s/${token}?meta=1`, { host: a.host })).status).toBe(200)

    const onRoot = await callJson(app, `/s/${token}`, { host: ROOT })
    const unknown = await callJson(app, "/s/NoSuchToken1", { host: ROOT })
    expect(onRoot.status).toBe(404)
    expect(unknown.status).toBe(404)
    expect(onRoot.body).toEqual(unknown.body)
    expect((await callJson(app, `/s/${token}?meta=1`, { host: ROOT })).status).toBe(404)
    expect((await callJson(app, `/s/${token}`, { host: b.host })).status).toBe(404)

    // a root link is likewise invisible from the tenant host
    const rootFile = await upload(ROOT, owner.token, "root.txt", "root bytes")
    const rootToken = await share(ROOT, owner.token, rootFile)
    expect((await callJson(app, `/s/${rootToken}`, { host: ROOT })).status).toBe(200)
    expect((await callJson(app, `/s/${rootToken}`, { host: a.host })).status).toBe(404)
  })

  test("a burn-on-view link on the wrong host is not consumed", async () => {
    const owner = await signupOwner(app)
    const a = await teamWithAdmin(app, owner, "acme")
    const fileId = await upload(a.host, a.admin.token, "once.txt", "once")
    const res = await callJson(app, "/shares", {
      method: "POST",
      host: a.host,
      token: a.admin.token,
      body: { file_id: fileId, expires_in: 3600, burn_on_view: true },
    })
    expect(res.status).toBe(201)
    expect((await callJson(app, `/s/${res.body.token}`, { host: ROOT })).status).toBe(404)
    const home = await callJson(app, `/s/${res.body.token}`, { host: a.host })
    expect(home.status).toBe(200)
    expect(home.body).toBe("once")
  })
})

describe("/p/:username/:folderId and /p/files/:id", () => {
  test("a public folder is served on its owner's team host only", async () => {
    const owner = await signupOwner(app)
    const a = await teamWithAdmin(app, owner, "acme")
    const folder = await callJson(app, "/folders", {
      method: "POST",
      host: a.host,
      token: a.admin.token,
      body: { name: "gallery", is_public: true },
    })
    expect(folder.status).toBe(201)
    const folderId = folder.body.id as number
    const fileId = await upload(a.host, a.admin.token, "pic.txt", "public bytes", folderId)
    const username = a.created.admin.username

    const home = await callJson(app, `/p/${username}/${folderId}`, { host: a.host })
    expect(home.status).toBe(200)
    expect(home.body.files).toHaveLength(1)
    const file = await callJson(app, `/p/files/${fileId}`, { host: a.host })
    expect(file.status).toBe(200)
    expect(file.body).toBe("public bytes")

    const onRoot = await callJson(app, `/p/${username}/${folderId}`, { host: ROOT })
    expect(onRoot.status).toBe(404)
    expect(onRoot.body).toEqual({ error: "Not found" })
    expect((await callJson(app, `/p/${username}/${folderId}`, { host: hostOf("beta") })).status).toBe(404)
    expect((await callJson(app, `/p/files/${fileId}`, { host: ROOT })).status).toBe(404)
    expect((await callJson(app, `/p/files/${fileId}/thumb`, { host: ROOT })).status).toBe(404)
  })
})

describe("share urls handed out by the api", () => {
  test("mcp share tools build links on the requesting team's host", async () => {
    const owner = await signupOwner(app)
    await settings(owner, { mcp_enabled: true, mcp_tool_share: true })
    const a = await teamWithAdmin(app, owner, "acme")
    const fileId = await upload(a.host, a.admin.token, "doc.txt", "doc")

    const call = await callJson(app, "/mcp", {
      method: "POST",
      host: a.host,
      token: a.admin.token,
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "create_share", arguments: { file_id: fileId, expires_in: 3600 } },
      },
    })
    expect(call.status).toBe(200)
    expect(call.body.result.isError).toBeUndefined()
    const created = JSON.parse(call.body.result.content[0].text) as { url: string; token: string }
    expect(created.url).toBe(`http://${hostOf("acme")}/s/${created.token}`)

    const list = await callJson(app, "/mcp", {
      method: "POST",
      host: a.host,
      token: a.admin.token,
      body: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_shares", arguments: {} } },
    })
    const rows = JSON.parse(list.body.result.content[0].text) as Array<{ url: string }>
    expect(rows.every(r => r.url.startsWith(`http://${hostOf("acme")}/s/`))).toBe(true)

    // and the link it minted follows the same host rule as any other
    expect((await callJson(app, `/s/${created.token}`, { host: a.host })).status).toBe(200)
    expect((await callJson(app, `/s/${created.token}`, { host: ROOT })).status).toBe(404)
  })
})
