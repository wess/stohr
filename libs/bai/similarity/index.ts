// Vector ops. No SIMD here — Float32Array.reduce is fast enough for
// individual queries (sub-millisecond at 1024 dims). For ANN over
// millions of vectors, store them in pgvector + an HNSW index instead.

export const dot = (a: Float32Array, b: Float32Array): number => {
  if (a.length !== b.length) {
    throw new Error(`bai: vector dim mismatch (${a.length} vs ${b.length})`)
  }
  let acc = 0
  for (let i = 0; i < a.length; i++) acc += (a[i] as number) * (b[i] as number)
  return acc
}

const norm = (v: Float32Array): number => {
  let acc = 0
  for (let i = 0; i < v.length; i++) {
    const x = v[i] as number
    acc += x * x
  }
  return Math.sqrt(acc)
}

export const cosineSim = (a: Float32Array, b: Float32Array): number => {
  const na = norm(a)
  const nb = norm(b)
  if (na === 0 || nb === 0) return 0
  return dot(a, b) / (na * nb)
}
