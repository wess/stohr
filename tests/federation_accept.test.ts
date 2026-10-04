import { randomUUID } from "node:crypto"
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { router } from "@atlas/server"
import { authRoutes } from "../src/auth/index.ts"
import { sha256Hex } from "../src/federation/crypto.ts"
import { federationFilesRoutes } from "../src/federation/files.ts"
import { federationRoutes } from "../src/federation/index.ts"
import { generateEd25519, generateX25519, signEd25519 } from "../src/federation/keys.ts"
import { pairingReceiverRoutes } from "../src/federation/pairing.ts"
import { buildSigningString } from "../src/federation/transport.ts"
import { inviteRoutes } from "../src/invites/index.ts"
import { SETTING_FEDERATION_ENABLED, seedIfMissing } from "../src/settings/index.ts"
import { callJson, fakeStore } from "./helpers/http.ts"
import { db, TEST_SECRET, truncateAll } from "./setup.ts"

const HOME = "https://home.test"

const app = router(
  ...authRoutes(db, TEST_SECRET),
  ...inviteRoutes(db, TEST_SECRET),
  ...federationRoutes(db, TEST_SECRET, HOME),
  ...federationFilesRoutes(db, TEST_SECRET, fakeStore),
  ...pairingReceiverRoutes(db, HOME),
)

const b64url = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url")

// what an attacker (or any other instance) can mint: a well-formed invite
// signed by a key of their choosing
const forgeInvite = (
  key: { privatePem: string; publicRaw: string },
  body: { slug: string; introducer: string; type?: string; fed_id?: number },
) => {
  const header = b64url({ v: 1, alg: "Ed25519", kid: key.publicRaw })
  const payload = b64url({
    fed_id: body.fed_id ?? 1,
    slug: body.slug,
    name: body.slug,
    type: body.type ?? "content-sharing",
    introducer: body.introducer,
    exp: Math.floor(Date.now() / 1000) + 3600,
    nonce: randomUUID(),
  })
  return `${header}.${payload}.${signEd25519(key.privatePem, `${header}.${payload}`)}`
}

const signup = async (name: string, username: string, email: string, invite?: string) => {
  const res = await callJson(app, "/signup", {
    method: "POST",
    body: { name, username, email, password: "password123", invite_token: invite },
  })
  expect(res.status).toBe(201)
  return res.body as { id: number; token: string }
}

const ownerAndPeer = async () => {
  const alice = await signup("Alice", "alice", "alice@x.test")
  const inv = await callJson(app, "/invites", { method: "POST", body: {}, token: alice.token })
  const bob = await signup("Bob", "bob", "bob@x.test", inv.body.token)
  return { alice, bob }
}

const createFederation = async (token: string, slug: string) => {
  const res = await callJson(app, "/me/federations", {
    method: "POST",
    token,
    body: { slug, name: slug, type: "content-sharing" },
  })
  expect(res.status).toBe(201)
  return res.body as { id: number; public_key: string; pubkey_raw: string }
}

const federationCount = async (slug: string) => {
  const row = (await db.one({
    text: "SELECT COUNT(*)::int AS n FROM federations WHERE slug = $1",
    values: [slug],
  })) as { n: number }
  return row.n
}

beforeAll(async () => {
  await db.execute({ text: "TRUNCATE TABLE federations, federation_nonces RESTART IDENTITY CASCADE", values: [] })
})
beforeEach(async () => {
  await truncateAll()
  await db.execute({ text: "TRUNCATE TABLE federations, federation_nonces RESTART IDENTITY CASCADE", values: [] })
  await seedIfMissing(db, SETTING_FEDERATION_ENABLED, true)
})
afterEach(() => {
  delete process.env.FEDERATION_ALLOW_HTTP
})

describe("federation accept: invite forgery", () => {
  test("an invite for a known slug signed by a different key is refused before any network call", async () => {
    const { alice, bob } = await ownerAndPeer()
    await createFederation(alice.token, "alpha")

    const attacker = generateEd25519()
    const token = forgeInvite(attacker, { slug: "alpha", introducer: "https://evil.example.com" })
    const res = await callJson(app, "/me/federations/accept", { method: "POST", token: bob.token, body: { invite: token } })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/does not match/)

    const bobRows = (await db.one({
      text: "SELECT COUNT(*)::int AS n FROM federation_members WHERE user_id = $1",
      values: [bob.id],
    })) as { n: number }
    expect(bobRows.n).toBe(0)
  })

  test("an existing member is told so, even with the right key", async () => {
    const { alice } = await ownerAndPeer()
    const fed = await createFederation(alice.token, "alpha")
    const other = generateEd25519()
    // kid mismatch would also 409, but membership is checked first
    const token = forgeInvite(other, { slug: "alpha", introducer: "https://evil.example.com", fed_id: fed.id })
    const res = await callJson(app, "/me/federations/accept", { method: "POST", token: alice.token, body: { invite: token } })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/Already a member/)
  })

  test("introducers on private or plain-http addresses are refused", async () => {
    const { bob } = await ownerAndPeer()
    const key = generateEd25519()
    for (const introducer of ["https://10.0.0.5", "https://169.254.169.254", "https://localhost:3000", "http://93.184.216.34"]) {
      const token = forgeInvite(key, { slug: "beta", introducer })
      const res = await callJson(app, "/me/federations/accept", { method: "POST", token: bob.token, body: { invite: token } })
      expect(res.status).toBe(422)
      expect(res.body.error).toMatch(/introducer/i)
    }
    expect(await federationCount("beta")).toBe(0)
  })
})

// a scripted introducer: answers /federation/pair with whatever federation
// identity the test wants to claim
const fakeIntroducer = (respond: (body: any) => Record<string, unknown> | { status: number }) => {
  const seen: any[] = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const body = await req.json()
      seen.push(body)
      const out = respond(body)
      if ("status" in out && typeof out.status === "number" && Object.keys(out).length === 1) {
        return new Response(JSON.stringify({ error: "nope", secret: "introducer-internal-detail" }), {
          status: out.status,
          headers: { "content-type": "application/json" },
        })
      }
      return Response.json(out)
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, seen, stop: () => server.stop(true) }
}

const pairResponseFor = (fedKey: { publicPem: string }, slug: string, introducerUrl: string) => {
  const intro = generateEd25519()
  const introX = generateX25519()
  return {
    federation: {
      id: 7,
      slug,
      name: slug,
      description: null,
      type: "content-sharing",
      public_key: fedKey.publicPem,
      replication_factor: 3,
      erasure_k: null,
      erasure_m: null,
      quota_multiplier: "1.00",
    },
    group_key_sealed: null,
    introducer: {
      peer_pubkey: intro.publicRaw,
      peer_x25519_pubkey: introX.publicRaw,
      peer_base_url: introducerUrl,
    },
    members: [],
  }
}

describe("federation accept: introducer handshake", () => {
  test("an introducer returning a different federation key is refused", async () => {
    process.env.FEDERATION_ALLOW_HTTP = "true"
    const { bob } = await ownerAndPeer()
    const signer = generateEd25519()
    const impostor = generateEd25519()
    const intro = fakeIntroducer(() => pairResponseFor(impostor, "gamma", "http://127.0.0.1:1"))
    try {
      const token = forgeInvite(signer, { slug: "gamma", introducer: intro.url })
      const res = await callJson(app, "/me/federations/accept", { method: "POST", token: bob.token, body: { invite: token } })
      expect(res.status).toBe(502)
      expect(intro.seen).toHaveLength(1)
      expect(await federationCount("gamma")).toBe(0)
    } finally {
      intro.stop()
    }
  })

  test("an introducer error is not reflected to the caller", async () => {
    process.env.FEDERATION_ALLOW_HTTP = "true"
    const { bob } = await ownerAndPeer()
    const signer = generateEd25519()
    const intro = fakeIntroducer(() => ({ status: 409 }))
    try {
      const token = forgeInvite(signer, { slug: "delta", introducer: intro.url })
      const res = await callJson(app, "/me/federations/accept", { method: "POST", token: bob.token, body: { invite: token } })
      expect(res.status).toBe(502)
      expect(JSON.stringify(res.body)).not.toContain("introducer-internal-detail")
      expect(res.body.detail).toBeUndefined()
    } finally {
      intro.stop()
    }
  })

  test("a consistent handshake joins the federation", async () => {
    process.env.FEDERATION_ALLOW_HTTP = "true"
    const { bob } = await ownerAndPeer()
    const signer = generateEd25519()
    const intro = fakeIntroducer(() => pairResponseFor(signer, "epsilon", intro.url))
    try {
      const token = forgeInvite(signer, { slug: "epsilon", introducer: intro.url })
      const res = await callJson(app, "/me/federations/accept", { method: "POST", token: bob.token, body: { invite: token } })
      expect(res.status).toBe(201)
      expect(res.body.slug).toBe("epsilon")
      // the joiner identified itself with our configured public URL
      expect(intro.seen[0].peer_base_url).toBe(HOME)
      const fed = (await db.one({
        text: "SELECT public_key FROM federations WHERE slug = $1",
        values: ["epsilon"],
      })) as { public_key: string }
      expect(fed.public_key).toBe(signer.publicPem)
    } finally {
      intro.stop()
    }
  })

  test("without the dev flag an http introducer is refused before the handshake", async () => {
    const { bob } = await ownerAndPeer()
    const signer = generateEd25519()
    const intro = fakeIntroducer(() => pairResponseFor(signer, "zeta", "http://127.0.0.1:1"))
    try {
      const token = forgeInvite(signer, { slug: "zeta", introducer: intro.url })
      const res = await callJson(app, "/me/federations/accept", { method: "POST", token: bob.token, body: { invite: token } })
      expect(res.status).toBe(422)
      expect(intro.seen).toHaveLength(0)
    } finally {
      intro.stop()
    }
  })
})

describe("pairing receiver", () => {
  test("refuses a private peer_base_url without burning the invite", async () => {
    const { alice } = await ownerAndPeer()
    const fed = await createFederation(alice.token, "alpha")
    const minted = await callJson(app, `/me/federations/${fed.id}/invites`, { method: "POST", token: alice.token, body: {} })
    expect(minted.status).toBe(201)

    const joiner = generateEd25519()
    const joinerX = generateX25519()
    const res = await callJson(app, "/federation/pair", {
      method: "POST",
      body: {
        invite: minted.body.token,
        peer_pubkey: joiner.publicRaw,
        peer_x25519_pubkey: joinerX.publicRaw,
        peer_base_url: "https://192.168.1.10",
      },
    })
    expect(res.status).toBe(422)
    expect(res.body.error).toMatch(/peer_base_url/)

    const invites = await callJson(app, `/me/federations/${fed.id}/invites`, { token: alice.token })
    expect(invites.body).toHaveLength(1)
    expect(invites.body[0].used_at).toBeNull()
  })

  test("oversized pair bodies are refused with 413", async () => {
    const res = await callJson(app, "/federation/pair", {
      method: "POST",
      body: { invite: "x".repeat(2 * 1024 * 1024) },
    })
    expect(res.status).toBe(413)
  })
})

// signs a request the way peerFetch does, for a key the test controls
const signedHeaders = (
  key: { privatePem: string; publicRaw: string },
  method: string,
  pathWithQuery: string,
  body: Uint8Array | null,
  nonce = randomUUID().replace(/-/g, ""),
) => {
  const ts = Math.floor(Date.now() / 1000)
  const bodySha = body && body.length > 0 ? sha256Hex(body) : "-"
  const sig = signEd25519(key.privatePem, buildSigningString(method, pathWithQuery, ts, nonce, bodySha))
  return {
    "x-fed-pubkey": key.publicRaw,
    "x-fed-ts": String(ts),
    "x-fed-nonce": nonce,
    "x-fed-body-sha": bodySha,
    "x-fed-sig": sig,
  }
}

const peerCall = (path: string, headers: Record<string, string>, method = "GET", body?: Uint8Array) =>
  app(
    new Request(`http://test.local${path}`, {
      method,
      headers,
      body: body ? (body.buffer as ArrayBuffer) : undefined,
    }),
  )

describe("peer transport", () => {
  test("unknown peers are refused before the body is considered", async () => {
    const { alice } = await ownerAndPeer()
    await createFederation(alice.token, "alpha")
    const stranger = generateEd25519()
    const path = `/federation/blob/alpha/${randomUUID()}`
    const res = await peerCall(path, signedHeaders(stranger, "GET", path, null))
    expect(res.status).toBe(403)
  })

  test("a replayed nonce is refused", async () => {
    const { alice } = await ownerAndPeer()
    const fed = await createFederation(alice.token, "alpha")
    const peer = generateEd25519()
    await db.execute({
      text: `INSERT INTO federation_members
               (federation_id, user_id, peer_pubkey, peer_x25519_pubkey, peer_base_url, is_local, is_admin, status)
             VALUES ($1, NULL, $2, $3, 'https://peer.test', FALSE, FALSE, 'active')`,
      values: [fed.id, peer.publicRaw, generateX25519().publicRaw],
    })
    const path = `/federation/blob/alpha/${randomUUID()}`
    const headers = signedHeaders(peer, "GET", path, null)

    const first = await peerCall(path, headers)
    // signature + membership + nonce all passed; the blob simply isn't here
    expect(first.status).toBe(404)

    const replay = await peerCall(path, headers)
    expect(replay.status).toBe(401)
    expect((await replay.json()).error).toMatch(/Replayed/)

    // a fresh nonce from the same peer still works
    const again = await peerCall(path, signedHeaders(peer, "GET", path, null))
    expect(again.status).toBe(404)
  })

  test("a body that does not match the signed hash is refused", async () => {
    const { alice } = await ownerAndPeer()
    const fed = await createFederation(alice.token, "alpha")
    const peer = generateEd25519()
    await db.execute({
      text: `INSERT INTO federation_members
               (federation_id, user_id, peer_pubkey, peer_x25519_pubkey, peer_base_url, is_local, is_admin, status)
             VALUES ($1, NULL, $2, $3, 'https://peer.test', FALSE, FALSE, 'active')`,
      values: [fed.id, peer.publicRaw, generateX25519().publicRaw],
    })
    const path = `/federation/blob/alpha/${randomUUID()}`
    const signedBody = new TextEncoder().encode("the real bytes")
    const headers = {
      ...signedHeaders(peer, "POST", path, signedBody),
      "x-fed-owner-pubkey": peer.publicRaw,
      "content-type": "application/octet-stream",
    }
    const res = await peerCall(path, headers, "POST", new TextEncoder().encode("swapped bytes!"))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toMatch(/hash/)
  })
})
