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
