import { describe, expect, test } from "bun:test"
import { parseRange } from "../src/files/range.ts"

const SIZE = 1000

describe("parseRange", () => {
  test("no header means no range", () => {
    expect(parseRange(null, SIZE)).toEqual({ kind: "none" })
  })

  test("a malformed header is ignored rather than rejected", () => {
    expect(parseRange("items=0-10", SIZE)).toEqual({ kind: "none" })
    expect(parseRange("bytes=abc", SIZE)).toEqual({ kind: "none" })
  })

  test("multipart ranges fall back to the full object", () => {
    expect(parseRange("bytes=0-99,200-299", SIZE)).toEqual({ kind: "none" })
  })

  test("explicit start and end", () => {
    expect(parseRange("bytes=0-499", SIZE)).toEqual({ kind: "satisfiable", range: { start: 0, end: 499 } })
  })

  test("open-ended range runs to the last byte", () => {
    expect(parseRange("bytes=500-", SIZE)).toEqual({ kind: "satisfiable", range: { start: 500, end: 999 } })
  })

  test("suffix range takes the tail", () => {
    expect(parseRange("bytes=-200", SIZE)).toEqual({ kind: "satisfiable", range: { start: 800, end: 999 } })
  })

  test("suffix longer than the object clamps to the whole object", () => {
    expect(parseRange("bytes=-5000", SIZE)).toEqual({ kind: "satisfiable", range: { start: 0, end: 999 } })
  })

  test("an end past the last byte is clamped, not rejected", () => {
    expect(parseRange("bytes=900-5000", SIZE)).toEqual({ kind: "satisfiable", range: { start: 900, end: 999 } })
  })

  test("Safari's opening probe is satisfiable", () => {
    expect(parseRange("bytes=0-1", SIZE)).toEqual({ kind: "satisfiable", range: { start: 0, end: 1 } })
  })

  test("a start at or past the end is unsatisfiable", () => {
    expect(parseRange("bytes=1000-", SIZE)).toEqual({ kind: "unsatisfiable" })
    expect(parseRange("bytes=2000-3000", SIZE)).toEqual({ kind: "unsatisfiable" })
  })

  test("a zero-length object has no satisfiable range", () => {
    expect(parseRange("bytes=0-", 0)).toEqual({ kind: "unsatisfiable" })
  })

  test("whitespace around the header is tolerated", () => {
    expect(parseRange("  bytes=10-20  ", SIZE)).toEqual({ kind: "satisfiable", range: { start: 10, end: 20 } })
  })
})
