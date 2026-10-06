import { beforeEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { encodeCBOR } from "@levischuck/tiny-cbor"
import { from } from "@atlas/db"
import { router } from "@atlas/server"
import { db, truncateAll, TEST_SECRET } from "./setup.ts"
import { buildApp, callJson } from "./helpers/http.ts"
import { passkeyRoutes } from "../src/auth/passkeys.ts"

const app = router(
  ...passkeyRoutes(db, TEST_SECRET, { rpId: "test.local", rpName: "Stohr", rpOrigin: "http://test.local" }),
)
beforeEach(truncateAll)
const assertion = async (uv: boolean) => {
  const user = await callJson(buildApp(db, TEST_SECRET), "/signup", {
    method: "POST",
    body: {
      username: "owner",
      email: "owner@example.com",
      password: "password123",
    },
  })
  const keys = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )
  const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey)
  const publicKey = encodeCBOR(
    new Map<number, number | Uint8Array>([
      [1, 3],
      [3, -257],
      [-1, new Uint8Array(Buffer.from(jwk.n!, "base64url"))],
      [-2, new Uint8Array(Buffer.from(jwk.e!, "base64url"))],
    ]),
  )
  const id = Buffer.from("credential").toString("base64url")
  await db.execute(
    from("webauthn_credentials").insert({
      user_id: user.body.id,
      credential_id: id,
      public_key: Buffer.from(publicKey).toString("base64url"),
      transports: "[]",
    }),
  )
  const options = await callJson(app, "/login/passkey/discover/start", { method: "POST", body: {} })
  expect(options.body.userVerification).toBe("required")
  const clientData = Buffer.from(
    JSON.stringify({ type: "webauthn.get", challenge: options.body.challenge, origin: "http://test.local" }),
  )
  const authData = Buffer.concat([
    createHash("sha256").update("test.local").digest(),
    Buffer.from([uv ? 5 : 1, 0, 0, 0, 0]),
  ])
  const data = Buffer.concat([authData, createHash("sha256").update(clientData).digest()])
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, data)
  return {
    userId: user.body.id as number,
    body: {
      response: {
        id,
        rawId: id,
        type: "public-key",
        clientExtensionResults: {},
        response: {
          clientDataJSON: clientData.toString("base64url"),
          authenticatorData: authData.toString("base64url"),
          signature: Buffer.from(sig).toString("base64url"),
        },
      },
    },
  }
}

describe("passwordless passkey boundaries", () => {
  test("a valid possession-only assertion cannot replace user verification", async () => {
    const { body } = await assertion(false)
    const res = await callJson(app, "/login/passkey/discover/finish", { method: "POST", body })
    expect(res.status).toBe(401)
    expect(res.body.error).toContain("User verification required")
  })
  test("a verified assertion is single use across concurrent submissions", async () => {
    const { body } = await assertion(true)
    const rows = await Promise.all(
      [1, 2].map(() => callJson(app, "/login/passkey/discover/finish", { method: "POST", body })),
    )
    expect(rows.map(r => r.status).sort()).toEqual([200, 400])
  })
  test("a suspended account cannot log in with a verified assertion", async () => {
    const { userId, body } = await assertion(true)
    await db.execute(
      from("users")
        .where(q => q("id").equals(userId))
        .update({ suspended_at: new Date() }),
    )
    expect((await callJson(app, "/login/passkey/discover/finish", { method: "POST", body })).status).toBe(401)
  })
})
