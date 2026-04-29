import { beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { from, raw } from "@atlas/db"
import { db, truncateAll, TEST_SECRET } from "./setup.ts"
import { buildApp, callJson } from "./helpers/http.ts"

let app: ReturnType<typeof buildApp>

beforeAll(() => {
  app = buildApp(db, TEST_SECRET)
})

beforeEach(async () => {
  await truncateAll()
})

const seedOwner = async () => {
  const res = await callJson(app, "/signup", {
    method: "POST",
    body: { name: "Owner", username: "owner", email: "owner@example.com", password: "password123" },
  })
  return { id: res.body.id as number, token: res.body.token as string }
}

const registerClient = async (ownerToken: string) => {
  const res = await callJson(app, "/admin/oauth/clients", {
    method: "POST",
    token: ownerToken,
    body: {
      name: "Stohrshot",
      redirect_uris: ["stohrshot://oauth/callback"],
      allowed_scopes: ["read", "write", "share"],
      is_official: true,
      is_public_client: true,
    },
  })
  expect(res.status).toBe(201)
  return res.body.client_id as string
}

describe("device authorize", () => {
  test("returns device_code, user_code, verification URIs, expires_in, interval", async () => {
    const owner = await seedOwner()
    const clientId = await registerClient(owner.token)
    const res = await callJson(app, "/oauth/device/authorize", {
      method: "POST",
      body: { client_id: clientId, scope: "read write share" },
    })
    expect(res.status).toBe(200)
    expect(res.body.device_code).toBeTruthy()
    expect(res.body.user_code).toMatch(/^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/)
    expect(res.body.verification_uri).toMatch(/\/pair$/)
    expect(res.body.verification_uri_complete).toContain(`code=${encodeURIComponent(res.body.user_code)}`)
    expect(res.body.expires_in).toBe(600)
    expect(res.body.interval).toBe(5)
  })

  test("rejects unknown client_id", async () => {
    const res = await callJson(app, "/oauth/device/authorize", {
      method: "POST",
      body: { client_id: "cli_nope" },
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe("invalid_client")
  })

  test("rejects scopes outside the client's allowed set", async () => {
    const owner = await seedOwner()
    const res = await callJson(app, "/admin/oauth/clients", {
      method: "POST",
      token: owner.token,
      body: {
        name: "ReadOnly",
        redirect_uris: ["stohrshot://oauth/callback"],
        allowed_scopes: ["read"],
        is_public_client: true,
      },
    })
    const clientId = res.body.client_id as string
    const dev = await callJson(app, "/oauth/device/authorize", {
      method: "POST",
      body: { client_id: clientId, scope: "read write" },
    })
    expect(dev.status).toBe(400)
    expect(dev.body.error).toBe("invalid_scope")
  })
})

describe("device polling lifecycle", () => {
  const start = async () => {
    const owner = await seedOwner()
    const clientId = await registerClient(owner.token)
    const dev = await callJson(app, "/oauth/device/authorize", {
      method: "POST",
      body: { client_id: clientId },
    })
    return { ownerToken: owner.token, clientId, dev: dev.body }
  }

  test("authorization_pending until the user approves", async () => {
    const { clientId, dev } = await start()
    const r = await callJson(app, "/oauth/token", {
      method: "POST",
      body: {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: clientId,
        device_code: dev.device_code,
      },
    })
    expect(r.status).toBe(400)
    expect(r.body.error).toBe("authorization_pending")
  })

  test("polling too fast returns slow_down", async () => {
    const { clientId, dev } = await start()
    const first = await callJson(app, "/oauth/token", {
      method: "POST",
      body: {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: clientId,
        device_code: dev.device_code,
      },
    })
    expect(first.body.error).toBe("authorization_pending")

    const second = await callJson(app, "/oauth/token", {
      method: "POST",
      body: {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: clientId,
        device_code: dev.device_code,
      },
    })
    expect(second.status).toBe(400)
    expect(second.body.error).toBe("slow_down")
  })

  test("expired_token after the device code's TTL", async () => {
    const { clientId, dev } = await start()
    // Force expiry into the past.
    await db.execute(
      from("oauth_device_codes").where(q => q("device_code").equals(dev.device_code)).update({
        expires_at: raw("NOW() - INTERVAL '5 minutes'"),
      }),
    )
    const r = await callJson(app, "/oauth/token", {
      method: "POST",
      body: {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: clientId,
        device_code: dev.device_code,
      },
    })
    expect(r.status).toBe(400)
    expect(r.body.error).toBe("expired_token")
  })

  test("/oauth/device/info returns client + scopes for a valid user_code", async () => {
    const { ownerToken, dev } = await start()
    const info = await callJson(app, `/oauth/device/info?user_code=${encodeURIComponent(dev.user_code)}`, {
      token: ownerToken,
    })
    expect(info.status).toBe(200)
    expect(info.body.client.name).toBe("Stohrshot")
    expect(info.body.scopes.length).toBeGreaterThan(0)
  })

  test("approve + device_code grant issues tokens once and burns the code", async () => {
    const { ownerToken, clientId, dev } = await start()

    const approve = await callJson(app, "/oauth/device/approve", {
      method: "POST",
      token: ownerToken,
      body: { user_code: dev.user_code },
    })
    expect(approve.status).toBe(200)

    // Force last_polled_at into the past so the slow_down check passes.
    await db.execute(
      from("oauth_device_codes").where(q => q("device_code").equals(dev.device_code))
        .update({ last_polled_at: raw("NOW() - INTERVAL '10 seconds'") }),
    )

    const tokens = await callJson(app, "/oauth/token", {
      method: "POST",
      body: {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: clientId,
        device_code: dev.device_code,
      },
    })
    expect(tokens.status).toBe(200)
    expect(tokens.body.access_token).toBeTruthy()
    expect(tokens.body.refresh_token).toMatch(/^oat_/)

    // Code is gone.
    const row = await db.one(
      from("oauth_device_codes").where(q => q("device_code").equals(dev.device_code)),
    )
    expect(row).toBeNull()

    // Replay → invalid_grant (code consumed).
    const replay = await callJson(app, "/oauth/token", {
      method: "POST",
      body: {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: clientId,
        device_code: dev.device_code,
      },
    })
    expect(replay.status).toBe(400)
    expect(replay.body.error).toBe("invalid_grant")
  })

  test("deny → access_denied on the next poll", async () => {
    const { ownerToken, clientId, dev } = await start()
    await callJson(app, "/oauth/device/deny", {
      method: "POST",
      token: ownerToken,
      body: { user_code: dev.user_code },
    })
    await db.execute(
      from("oauth_device_codes").where(q => q("device_code").equals(dev.device_code))
        .update({ last_polled_at: raw("NOW() - INTERVAL '10 seconds'") }),
    )
    const r = await callJson(app, "/oauth/token", {
      method: "POST",
      body: {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: clientId,
        device_code: dev.device_code,
      },
    })
    expect(r.status).toBe(400)
    expect(r.body.error).toBe("access_denied")
  })
})

describe("discovery", () => {
  test("device_authorization_endpoint and device_code grant are advertised", async () => {
    const r = await callJson(app, "/.well-known/oauth-authorization-server")
    expect(r.status).toBe(200)
    expect(r.body.device_authorization_endpoint).toMatch(/\/oauth\/device\/authorize$/)
    expect(r.body.grant_types_supported).toContain("urn:ietf:params:oauth:grant-type:device_code")
  })
})
