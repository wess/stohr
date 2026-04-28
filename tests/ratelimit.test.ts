import { beforeEach, describe, expect, test } from "bun:test"
import { db, truncateAll } from "./setup.ts"
import { checkRate } from "../src/security/ratelimit.ts"

describe("rate limit", () => {
  beforeEach(async () => {
    await truncateAll()
  })

  test("first request inside the limit", async () => {
    const r = await checkRate(db, "test:1", 3, 60)
    expect(r.ok).toBe(true)
    expect(r.count).toBe(1)
    expect(r.retryAfterSeconds).toBe(0)
  })

  test("counts increment until max, then block with retry-after", async () => {
    for (let i = 1; i <= 3; i++) {
      const r = await checkRate(db, "test:2", 3, 60)
      expect(r.ok).toBe(true)
      expect(r.count).toBe(i)
    }
    const blocked = await checkRate(db, "test:2", 3, 60)
    expect(blocked.ok).toBe(false)
    expect(blocked.count).toBe(4)
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0)
    expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(60)
  })

  test("buckets are independent", async () => {
    await checkRate(db, "test:a", 1, 60)
    const blockedA = await checkRate(db, "test:a", 1, 60)
    const freshB = await checkRate(db, "test:b", 1, 60)
    expect(blockedA.ok).toBe(false)
    expect(freshB.ok).toBe(true)
  })

  test("expired window resets the counter", async () => {
    // Seed an aged row directly so we don't have to wait wall-clock.
    await db.execute({
      text: `INSERT INTO rate_limits (bucket, count, window_started_at)
             VALUES ($1, $2, NOW() - INTERVAL '120 seconds')`,
      values: ["test:c", 99],
    })
    const r = await checkRate(db, "test:c", 5, 60)
    expect(r.ok).toBe(true)
    expect(r.count).toBe(1)
  })
})
