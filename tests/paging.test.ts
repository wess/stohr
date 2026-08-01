import { beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { from } from "@atlas/db"
import { db, truncateAll, TEST_SECRET } from "./setup.ts"
import { buildApp, callJson } from "./helpers/http.ts"

let app: ReturnType<typeof buildApp>

beforeAll(() => {
  app = buildApp(db, TEST_SECRET)
})

beforeEach(async () => {
  await truncateAll()
})

const signupOwner = async () => {
  const res = await callJson(app, "/signup", {
    method: "POST",
    body: { name: "Owner", username: "owner", email: "owner@example.com", password: "password123" },
  })
  return res.body as { id: number; token: string }
}

const seedFiles = async (userId: number, count: number) => {
  for (let i = 0; i < count; i++) {
    await db.execute(
      from("files").insert({
        user_id: userId,
        folder_id: null,
        name: `file-${String(i).padStart(4, "0")}.txt`,
        mime: "text/plain",
        size: 10,
        storage_key: `k-${i}`,
        version: 1,
      }),
    )
  }
}

const seedFolders = async (userId: number, count: number) => {
  for (let i = 0; i < count; i++) {
    await db.execute(
      from("folders").insert({
        user_id: userId,
        parent_id: null,
        name: `folder-${String(i).padStart(4, "0")}`,
      }),
    )
  }
}

describe("listing pagination", () => {
  test("files: limit caps the page and offset walks past it", async () => {
    const u = await signupOwner()
    await seedFiles(u.id, 12)

    const first = await callJson(app, "/files?folder_id=null&limit=5", { token: u.token })
    expect(first.status).toBe(200)
    expect(first.body.length).toBe(5)
    expect(first.headers.get("x-has-more")).toBe("true")
    expect(first.headers.get("x-limit")).toBe("5")

    const second = await callJson(app, "/files?folder_id=null&limit=5&offset=5", { token: u.token })
    expect(second.body.length).toBe(5)

    const third = await callJson(app, "/files?folder_id=null&limit=5&offset=10", { token: u.token })
    expect(third.body.length).toBe(2)
    expect(third.headers.get("x-has-more")).toBe("false")

    // Pages must partition the set — no repeats, nothing dropped.
    const ids = [...first.body, ...second.body, ...third.body].map((f: any) => f.id)
    expect(new Set(ids).size).toBe(12)
  })

  test("files past the old 200-row ceiling are reachable", async () => {
    const u = await signupOwner()
    await seedFiles(u.id, 205)

    const firstPage = await callJson(app, "/files?folder_id=null", { token: u.token })
    expect(firstPage.body.length).toBe(200)
    expect(firstPage.headers.get("x-has-more")).toBe("true")

    const rest = await callJson(app, "/files?folder_id=null&offset=200", { token: u.token })
    expect(rest.body.length).toBe(5)
    expect(rest.headers.get("x-has-more")).toBe("false")
  })

  test("folders paginate too", async () => {
    const u = await signupOwner()
    await seedFolders(u.id, 7)

    const first = await callJson(app, "/folders?parent_id=null&limit=3", { token: u.token })
    expect(first.status).toBe(200)
    expect(first.body.length).toBe(3)
    expect(first.headers.get("x-has-more")).toBe("true")

    const last = await callJson(app, "/folders?parent_id=null&limit=3&offset=6", { token: u.token })
    expect(last.body.length).toBe(1)
    expect(last.headers.get("x-has-more")).toBe("false")
  })

  test("limit is clamped and garbage falls back to the default", async () => {
    const u = await signupOwner()
    await seedFiles(u.id, 3)

    const huge = await callJson(app, "/files?folder_id=null&limit=999999", { token: u.token })
    expect(huge.headers.get("x-limit")).toBe("1000")

    const junk = await callJson(app, "/files?folder_id=null&limit=abc", { token: u.token })
    expect(junk.headers.get("x-limit")).toBe("200")

    const negative = await callJson(app, "/files?folder_id=null&limit=-5&offset=-9", { token: u.token })
    expect(negative.headers.get("x-limit")).toBe("1")
    expect(negative.headers.get("x-offset")).toBe("0")
  })

  test("omitting paging params preserves the previous default behaviour", async () => {
    const u = await signupOwner()
    await seedFiles(u.id, 4)

    const res = await callJson(app, "/files?folder_id=null", { token: u.token })
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
    expect(res.body.length).toBe(4)
  })
})
