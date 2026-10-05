import { describe, expect, test } from "bun:test"
import { rpIdFor } from "../src/auth/passkeys.ts"

const rp = { rpId: "app.stohr.io", rpName: "Stohr", rpOrigin: "https://app.stohr.io", rootDomain: "storage.wess.dev" }

const onTeam = (baseUrl: string): Request => {
  const req = new Request(baseUrl)
  ;(req as unknown as Record<string, unknown>).stohrTeam = { team: { id: 2 }, isRoot: false, baseUrl }
  return req
}

describe("passkey rp id", () => {
  test("verified custom hosts use their own RP id even when root and configured id match", () => {
    const req = onTeam("https://files.customer.com")
    ;(req as unknown as Record<string, unknown>).stohrTeam = {
      team: { id: 2, custom_domain: "files.customer.com", domain_verified_at: "now" },
      isRoot: false, baseUrl: "https://files.customer.com",
    }
    expect(rpIdFor(req, rp)).toBe("files.customer.com")
    expect(rpIdFor(req, { ...rp, rpId: rp.rootDomain })).toBe("files.customer.com")
  })

  test("root hosts keep the configured rp id", () => {
    expect(rpIdFor(new Request("https://app.stohr.io/"), rp)).toBe("app.stohr.io")
  })

  test("team hosts use the root domain", () => {
    expect(rpIdFor(onTeam("https://acme.storage.wess.dev"), rp)).toBe("storage.wess.dev")
  })

  test("without a root domain the configured id always wins", () => {
    expect(rpIdFor(onTeam("https://acme.storage.wess.dev"), { ...rp, rootDomain: undefined })).toBe("app.stohr.io")
  })
})
