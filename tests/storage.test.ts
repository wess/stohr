import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createStorage, drop, fetchObject, makeKey, put } from "../src/storage/index.ts"

describe("makeKey", () => {
  test("produces the u<id>/<stamp+rand>/<name> shape", () => {
    const key = makeKey(42, "photo.png")
    expect(key).toMatch(/^u42\/[0-9a-z]+[0-9a-f]{8}\/photo\.png$/)
  })

  test("sanitizes path-unsafe characters in the name", () => {
    const key = makeKey(1, "../../etc/passwd")
    expect(key.endsWith("/").valueOf()).toBe(false)
    // No raw slashes or dots-traversal survive in the name segment.
    const name = key.split("/").pop()
    expect(name).toBe(".._.._etc_passwd")
  })

  test("two calls never collide", () => {
    const a = makeKey(7, "f")
    const b = makeKey(7, "f")
    expect(a).not.toBe(b)
  })
})

describe("local storage driver", () => {
  let dir: string

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "stohr-storage-"))
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const store = () => createStorage({ driver: "local", dir })

  test("put then get round-trips the bytes", async () => {
    const h = store()
    const key = makeKey(1, "round.txt")
    await put(h, key, "hello world", "text/plain")
    const res = await fetchObject(h, key)
    expect(await res.text()).toBe("hello world")
  })

  test("put round-trips binary Uint8Array", async () => {
    const h = store()
    const key = makeKey(1, "bin.dat")
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef])
    await put(h, key, bytes)
    const res = await fetchObject(h, key)
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([...bytes])
  })

  // Ranged reads are drained through res.body — the same way the download
  // handler streams them — rather than via res.text(). Those two disagree:
  // handing a BunFile slice to `new Response(...)` produces a body stream
  // that honors the slice's start offset but runs to EOF, so a range read
  // returned every byte from `start` onward while the headers still claimed
  // the requested length. Asserting on .text() hides that entirely.
  const drainBody = async (res: Response): Promise<Uint8Array> => {
    const reader = res.body!.getReader()
    const chunks: Uint8Array[] = []
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
    }
    const total = chunks.reduce((n, c) => n + c.length, 0)
    const out = new Uint8Array(total)
    let at = 0
    for (const c of chunks) {
      out.set(c, at)
      at += c.length
    }
    return out
  }

  const RANGE_BODY = "0123456789abcdefghijklmnopqrstuvwxyz"

  test("ranged get streams only the requested window", async () => {
    const h = store()
    const key = makeKey(1, "ranged.txt")
    await put(h, key, RANGE_BODY, "text/plain")

    const res = await fetchObject(h, key, { start: 5, end: 14 })
    const bytes = await drainBody(res)
    expect(new TextDecoder().decode(bytes)).toBe("56789abcde")
    expect(bytes.length).toBe(10)
  })

  test("ranged get to the final byte", async () => {
    const h = store()
    const key = makeKey(1, "ranged-tail.txt")
    await put(h, key, RANGE_BODY, "text/plain")

    const res = await fetchObject(h, key, { start: 26, end: RANGE_BODY.length - 1 })
    const bytes = await drainBody(res)
    expect(new TextDecoder().decode(bytes)).toBe("qrstuvwxyz")
  })

  test("a single-byte range yields exactly one byte", async () => {
    const h = store()
    const key = makeKey(1, "ranged-one.txt")
    await put(h, key, RANGE_BODY, "text/plain")

    const res = await fetchObject(h, key, { start: 0, end: 0 })
    const bytes = await drainBody(res)
    expect(bytes.length).toBe(1)
    expect(new TextDecoder().decode(bytes)).toBe("0")
  })

  test("an unranged get still returns the whole object", async () => {
    const h = store()
    const key = makeKey(1, "ranged-full.txt")
    await put(h, key, RANGE_BODY, "text/plain")

    const res = await fetchObject(h, key)
    const bytes = await drainBody(res)
    expect(new TextDecoder().decode(bytes)).toBe(RANGE_BODY)
  })

  test("get on a missing key throws", async () => {
    const h = store()
    await expect(fetchObject(h, makeKey(9, "nope.txt"))).rejects.toThrow()
  })

  test("drop removes the object and is idempotent", async () => {
    const h = store()
    const key = makeKey(1, "gone.txt")
    await put(h, key, "bye")
    await drop(h, key)
    await expect(fetchObject(h, key)).rejects.toThrow()
    // Dropping again tolerates the missing file (matches the S3 driver).
    await drop(h, key)
  })

  test("rejects keys that escape the storage root", async () => {
    const h = store()
    await expect(put(h, "../escape.txt", "x")).rejects.toThrow(/escapes root/)
    await expect(fetchObject(h, "../../escape.txt")).rejects.toThrow(/escapes root/)
  })
})

describe("createStorage", () => {
  test("rejects an unknown driver", () => {
    expect(() => createStorage({ driver: "ftp" } as never)).toThrow(/Unknown storage driver/)
  })
})
