export const randomToken = (bytes = 24) => {
  const buf = crypto.getRandomValues(new Uint8Array(bytes))
  return Array.from(buf).map(b => b.toString(16).padStart(2, "0")).join("")
}
