import { describe, expect, test } from "bun:test"
import { safeRedirectPath } from "../src/auth/redirect.ts"

const APP = "http://test.local"

describe("safeRedirectPath", () => {
  test("defaults to / when nothing was asked for", () => {
    expect(safeRedirectPath(null, APP)).toBe("/")
    expect(safeRedirectPath(undefined, APP)).toBe("/")
    expect(safeRedirectPath("", APP)).toBe("/")
  })

  test("keeps same-origin path and query, drops the fragment", () => {
    expect(safeRedirectPath("/files?folder=3#token=x", APP)).toBe("/files?folder=3")
    expect(safeRedirectPath("/app/settings", APP)).toBe("/app/settings")
    expect(safeRedirectPath("http://test.local/ok?a=1", APP)).toBe("/ok?a=1")
  })

  test("refuses anything that leaves the origin", () => {
    expect(safeRedirectPath("//evil.com/x", APP)).toBe("/")
    expect(safeRedirectPath("/\\evil.com", APP)).toBe("/")
    expect(safeRedirectPath("\\\\evil.com", APP)).toBe("/")
    expect(safeRedirectPath("https://evil.com/x", APP)).toBe("/")
    expect(safeRedirectPath("http://test.local:3001/x", APP)).toBe("/")
    expect(safeRedirectPath("javascript:alert(1)", APP)).toBe("/")
    expect(safeRedirectPath("data:text/html,hi", APP)).toBe("/")
  })

  test("tolerates a trailing slash on APP_URL", () => {
    expect(safeRedirectPath("/x", "http://test.local/")).toBe("/x")
  })
})
