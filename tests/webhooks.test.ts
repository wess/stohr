import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { router } from "@atlas/server"
import { authRoutes } from "../src/auth/index.ts"
import { webhookRoutes } from "../src/webhooks/index.ts"
import { callJson } from "./helpers/http.ts"
import { db, TEST_SECRET, truncateAll } from "./setup.ts"

const app = router(...authRoutes(db, TEST_SECRET), ...webhookRoutes(db, TEST_SECRET))

const signup = async () => {
  const res = await callJson(app, "/signup", {
    method: "POST",
    body: { name: "Alice", username: "alice", email: "alice@x.test", password: "password123" },
  })
  expect(res.status).toBe(201)
  return res.body as { id: number; token: string }
}

const create = (token: string, url: string) =>
  callJson(app, "/webhooks", { method: "POST", token, body: { url, events: ["file.created"] } })

beforeEach(async () => {
  await truncateAll()
})
afterEach(() => {
  delete process.env.WEBHOOKS_ALLOW_PRIVATE
})

describe("webhook registration", () => {
  test("targets on private, loopback or link-local addresses are refused", async () => {
    const { token } = await signup()
    for (const url of [
      "http://169.254.169.254/latest/meta-data",
      "http://127.0.0.1:5432/",
      "http://localhost:3000/hook",
      "https://[::1]/hook",
      "http://10.0.0.7/hook",
      "http://192.168.4.87/hook",
      "ftp://93.184.216.34/hook",
    ]) {
      const res = await create(token, url)
      expect(res.status).toBe(422)
    }
  })

  test("a public target is accepted over http or https", async () => {
    const { token } = await signup()
    expect((await create(token, "http://93.184.216.34/hook")).status).toBe(201)
    expect((await create(token, "https://93.184.216.34/hook")).status).toBe(201)
  })

  test("patching to a private target is refused", async () => {
    const { token } = await signup()
    const made = await create(token, "https://93.184.216.34/hook")
    const res = await callJson(app, `/webhooks/${made.body.id}`, {
      method: "PATCH",
      token,
      body: { url: "http://169.254.169.254/" },
    })
    expect(res.status).toBe(422)
    const list = await callJson(app, "/webhooks", { token })
    expect(list.body[0].url).toBe("https://93.184.216.34/hook")
  })

  test("WEBHOOKS_ALLOW_PRIVATE opens LAN targets", async () => {
    process.env.WEBHOOKS_ALLOW_PRIVATE = "true"
    const { token } = await signup()
    expect((await create(token, "http://192.168.4.87:5678/hook")).status).toBe(201)
  })
})

describe("webhook deliveries", () => {
  test("the receiver's response body is neither stored nor served", async () => {
    const { token } = await signup()
    const made = await create(token, "https://93.184.216.34/hook")
    await db.execute({
      text: `INSERT INTO webhook_deliveries (webhook_id, event, payload, status_code, duration_ms)
             VALUES ($1, 'file.created', '{}', 200, 12)`,
      values: [made.body.id],
    })
    const columns = (await db.execute({
      text: `SELECT column_name FROM information_schema.columns WHERE table_name = 'webhook_deliveries'`,
      values: [],
    })) as Array<{ column_name: string }>
    expect(columns.map(c => c.column_name)).not.toContain("response_body")

    const res = await callJson(app, `/webhooks/${made.body.id}/deliveries`, { token })
    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(1)
    expect(Object.keys(res.body[0]).sort()).toEqual(["created_at", "duration_ms", "event", "id", "status_code"])
  })
})
