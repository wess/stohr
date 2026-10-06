import { spawn } from "bun"

const read = async (stream: ReadableStream<Uint8Array>, max: number): Promise<Uint8Array> => {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > max) throw new Error("Parser output exceeds limit")
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

export const runProcess = async (
  cmd: string[],
  input: Uint8Array | null,
  opts: { maxBytes: number; timeoutMs: number },
): Promise<{ stdout: Uint8Array; ok: boolean; error?: string }> => {
  let proc: ReturnType<typeof spawn> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    proc = spawn(cmd, { stdin: input ? "pipe" : "ignore", stdout: "pipe", stderr: "pipe" })
    const child = proc
    let timedOut = false
    timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, opts.timeoutMs)
    // drain both outputs before feeding stdin; parsers can write before reading
    const [out, err, code] = await Promise.all([
      read(child.stdout as ReadableStream<Uint8Array>, opts.maxBytes),
      read(child.stderr as ReadableStream<Uint8Array>, 64 * 1024),
      child.exited,
      (async () => {
        if (input && child.stdin) {
          const writer = child.stdin as { write: (bytes: Uint8Array) => number; end: () => void }
          writer.write(input)
          writer.end()
        }
      })(),
    ])
    if (timedOut) return { stdout: new Uint8Array(), ok: false, error: "Parser timed out" }
    if (code !== 0)
      return {
        stdout: new Uint8Array(),
        ok: false,
        error: new TextDecoder().decode(err).slice(0, 500) || `exit ${code}`,
      }
    return { stdout: out, ok: true }
  } catch (err) {
    proc?.kill("SIGKILL")
    await proc?.exited
    return { stdout: new Uint8Array(), ok: false, error: (err as Error).message }
  } finally {
    if (timer) clearTimeout(timer)
  }
}
