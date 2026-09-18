import { afterEach, describe, expect, test } from "bun:test"
import { createEmailer } from "../src/email/index.ts"

// Stub fetch per test and record what the emailer sent, so these run without
// a network or a database.
const realFetch = globalThis.fetch
let calls: { url: string; init: RequestInit }[] = []

const stubFetch = (status = 200, body: unknown = { id: "em_1" }) => {
  calls = []
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return new Response(JSON.stringify(body), { status })
  }) as typeof fetch
}

afterEach(() => {
  globalThis.fetch = realFetch
})

const message = { to: "a@example.com", subject: "hi", html: "<p>hi</p>" }

describe("createEmailer", () => {
  test("posts to Resend by default", async () => {
    stubFetch()
    const result = await createEmailer({ apiKey: "re_x", from: "Stohr <s@example.com>" }).send(message)
    expect(result).toEqual({ ok: true, id: "em_1" })
    expect(calls[0]?.url).toBe("https://api.resend.com/emails")
  })

  test("posts to a Resend-compatible server when apiUrl is set", async () => {
    stubFetch()
    await createEmailer({ apiKey: "cs_x", from: "s@example.com", apiUrl: "https://wess.email/api/" }).send(message)
    expect(calls[0]?.url).toBe("https://wess.email/api/emails")
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe("Bearer cs_x")
  })

  test("an empty apiUrl falls back to Resend", async () => {
    stubFetch()
    await createEmailer({ apiKey: "re_x", from: "s@example.com", apiUrl: "  " }).send(message)
    expect(calls[0]?.url).toBe("https://api.resend.com/emails")
  })

  test("names the server that refused, not Resend", async () => {
    stubFetch(403, { name: "validation_error" })
    const result = await createEmailer({ apiKey: "cs_x", from: "s@example.com", apiUrl: "https://wess.email/api" }).send(
      message,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.startsWith("wess.email 403")).toBe(true)
  })

  test("without a key it logs instead of sending", async () => {
    stubFetch()
    const result = await createEmailer({ apiKey: "", from: "s@example.com", apiUrl: "https://wess.email/api" }).send(
      message,
    )
    expect(result).toEqual({ ok: true, logged: true })
    expect(calls).toHaveLength(0)
  })
})
