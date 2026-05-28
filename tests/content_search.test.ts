import { beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { from, raw } from "@atlas/db"
import { db, truncateAll, TEST_SECRET } from "./setup.ts"
import { buildApp, callJson } from "./helpers/http.ts"
import { extractText } from "../src/search/content/extract.ts"

let app: ReturnType<typeof buildApp>

beforeAll(() => { app = buildApp(db, TEST_SECRET) })
beforeEach(async () => { await truncateAll() })

const signupOwner = async () => {
  const r = await callJson(app, "/signup", {
    method: "POST",
    body: { name: "Alice", username: "alice", email: "alice@x.test", password: "password123" },
  })
  return r.body as { id: number; token: string }
}

describe("content search", () => {
  test("plain-text extraction returns the text", async () => {
    const bytes = new TextEncoder().encode("This file describes the migration rollout plan.")
    const res = await extractText(bytes, { mime: "text/plain", name: "plan.txt" })
    expect(res.kind).toBe("text")
    if (res.kind === "text") {
      expect(res.text).toContain("migration rollout")
    }
  })

  test("HTML extraction strips tags", async () => {
    const html = "<html><body><h1>Hello</h1><p>World <b>strong</b></p></body></html>"
    const res = await extractText(new TextEncoder().encode(html), { mime: "text/html", name: "x.html" })
    expect(res.kind).toBe("text")
    if (res.kind === "text") {
      expect(res.text).toContain("Hello")
      expect(res.text).toContain("strong")
      expect(res.text).not.toContain("<b>")
    }
  })

  test("unknown binary types are skipped", async () => {
    const res = await extractText(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), { mime: "application/x-binary", name: "x.bin" })
    expect(res.kind).toBe("skip")
  })

  test("tsvector search picks up indexed content", async () => {
    const alice = await signupOwner()
    // Insert a file manually with text_content populated; the indexer
    // runs out-of-band, and we want to test the query layer in isolation.
    await db.execute(
      from("files").insert({
        user_id: alice.id,
        folder_id: null,
        name: "rollout.txt",
        mime: "text/plain",
        size: 32,
        storage_key: "manual-key-1",
        version: 1,
        text_content: "Plan the migration rollout carefully across regions",
        text_indexed_version: 1,
        text_indexed_at: raw("NOW()"),
      }),
    )
    const r = await callJson(app, "/search/content?q=migration", { token: alice.token })
    expect(r.status).toBe(200)
    expect(r.body.files.length).toBeGreaterThan(0)
    expect(r.body.files[0].name).toBe("rollout.txt")
    expect(r.body.files[0].snippet).toContain("<b>")
  })

  test("content search only returns files the caller can see", async () => {
    const alice = await signupOwner()
    const inv = await callJson(app, "/invites", { method: "POST", body: {}, token: alice.token })
    const bob = await callJson(app, "/signup", {
      method: "POST",
      body: { name: "Bob", username: "bob", email: "bob@x.test", password: "password123", invite_token: inv.body.token },
    })
    await db.execute(
      from("files").insert({
        user_id: alice.id, folder_id: null, name: "private.txt",
        mime: "text/plain", size: 10, storage_key: "k", version: 1,
        text_content: "topsecret",
        text_indexed_version: 1, text_indexed_at: raw("NOW()"),
      }),
    )
    const r = await callJson(app, "/search/content?q=topsecret", { token: bob.body.token })
    expect(r.status).toBe(200)
    expect(r.body.files).toHaveLength(0)
  })
})
