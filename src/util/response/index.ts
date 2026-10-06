// remote JSON is untrusted even when the operator chose the provider
export const responseJson = async (res: Response, maxBytes = 2 * 1024 * 1024): Promise<unknown> => {
  const length = Number(res.headers.get("content-length") ?? 0)
  if (length > maxBytes) {
    await res.body?.cancel()
    throw new Error("Remote response exceeds limit")
  }
  if (!res.body) throw new Error("Empty remote response")
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) {
        await reader.cancel()
        throw new Error("Remote response exceeds limit")
      }
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
  return JSON.parse(new TextDecoder().decode(bytes))
}
