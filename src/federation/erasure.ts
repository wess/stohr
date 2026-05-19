// Erasure-coding helpers for space-offering federations.
//
// The MVP uses a simplified scheme called "fragmented replication": the
// blob is split into K equal data fragments, then each fragment is hosted
// by R replicas (so we have K * R placements total). Reconstruction needs
// any one copy of each of the K fragments. This is NOT Reed-Solomon — it
// can't tolerate a peer holding fragment i AND a peer holding fragment j
// going down together if there are no other holders. But it has correct
// failure semantics, requires zero matrix math, and uses no GF(256) tables.
// A proper Reed-Solomon implementation slots in behind this same API
// (encode/decode swap shards K..M for parity shards) without touching the
// caller.
//
// shard_index in [0, M) where M = K * R. shard_index / R is the fragment;
// shard_index % R is the replica number.

export type ErasureConfig = {
  k: number       // logical fragments
  r: number       // replicas per fragment
  totalShards: number  // k * r
}

export const erasureConfig = (k: number, m: number): ErasureConfig => {
  // We re-interpret M as K * R. R = ceil(M / K). m must be ≥ k.
  if (k < 1 || m < k) throw new Error("erasure: invalid k/m")
  const r = Math.max(1, Math.ceil(m / k))
  return { k, r, totalShards: k * r }
}

export const shardCoordinates = (index: number, k: number): { fragment: number; replica: number } => {
  const cfg = erasureConfig(k, k * Math.max(1, Math.ceil(k / k)))
  return { fragment: Math.floor(index / cfg.r), replica: index % cfg.r }
}

export type EncodedShard = {
  index: number
  fragment: number
  replica: number
  size: number
  bytes: Uint8Array
}

// Split `data` into K fragments and replicate R times. Fragments are equal
// length (last fragment is padded; total_size in the blob row tracks the
// true byte length so the decoder knows where to truncate).
export const encode = (data: Uint8Array, k: number, r: number): EncodedShard[] => {
  const total = data.length
  const fragSize = Math.ceil(total / k)
  const fragments: Uint8Array[] = []
  for (let i = 0; i < k; i++) {
    const start = i * fragSize
    const end = Math.min(start + fragSize, total)
    const frag = new Uint8Array(fragSize)
    frag.set(data.subarray(start, end))
    // tail padding implicit (zeros) — decoder uses total_size to trim
    fragments.push(frag)
  }
  const shards: EncodedShard[] = []
  for (let fragIdx = 0; fragIdx < k; fragIdx++) {
    for (let rep = 0; rep < r; rep++) {
      shards.push({
        index: fragIdx * r + rep,
        fragment: fragIdx,
        replica: rep,
        size: fragments[fragIdx]!.length,
        bytes: fragments[fragIdx]!,
      })
    }
  }
  return shards
}

// Reassemble from any subset of shards. Need at least one shard per
// fragment index. Throws if a fragment has zero available shards.
export const decode = (
  shards: Array<{ index: number; bytes: Uint8Array }>,
  k: number,
  r: number,
  totalSize: number,
): Uint8Array => {
  const fragments: Array<Uint8Array | null> = new Array(k).fill(null)
  for (const s of shards) {
    const fragIdx = Math.floor(s.index / r)
    if (fragIdx >= 0 && fragIdx < k && !fragments[fragIdx]) {
      fragments[fragIdx] = s.bytes
    }
  }
  const missing = fragments.findIndex(f => f === null)
  if (missing !== -1) {
    throw new Error(`Cannot reconstruct: fragment ${missing} has no available shards`)
  }
  const out = new Uint8Array(totalSize)
  const fragSize = Math.ceil(totalSize / k)
  for (let i = 0; i < k; i++) {
    const start = i * fragSize
    const end = Math.min(start + fragSize, totalSize)
    out.set(fragments[i]!.subarray(0, end - start), start)
  }
  return out
}
