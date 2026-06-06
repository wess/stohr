import { randomUUID } from "node:crypto"
import type { Connection } from "@atlas/db"
import { from, raw } from "@atlas/db"
import { del, get, json, parseMultipart, pipeline, post, putHeader, stream } from "@atlas/server"
import { requireAuth } from "../auth/guard.ts"
import { requireSettingEnabled, SETTING_FEDERATION_ENABLED } from "../settings/index.ts"
import type { StorageHandle } from "../storage/index.ts"
import { drop, fetchObject, put } from "../storage/index.ts"
import { aesGcmDecrypt, aesGcmEncrypt, generateSymmetricKey, openSealedX25519, sealForX25519 } from "./crypto.ts"
import { decode, encode, erasureConfig } from "./erasure.ts"
import { getInstanceKeys } from "./keys.ts"
import type { FederationRow } from "./membership.ts"
import { federationById, federationBySlug, localMemberFor } from "./membership.ts"
import { selectPlacement } from "./placement.ts"
import { memberForPeer, peerFetch, requirePeerSignature } from "./transport.ts"

const authId = (c: any) => (c.assigns.auth as { id: number }).id

const FED_KEY = (federationId: number, blobId: string) => `fed:${federationId}:${blobId}`
const FED_SHARD_KEY = (federationId: number, blobId: string) => `fed-shard:${federationId}:${blobId}`

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

const openGroupKey = async (db: Connection, fed: FederationRow): Promise<Buffer> => {
  if (!fed.group_key_encrypted) throw new Error("No group key on this federation")
  const keys = await getInstanceKeys(db)
  return openSealedX25519(keys.x25519PrivatePem, fed.group_key_encrypted)
}

const _localContributionFolder = async (db: Connection, federationId: number, userId: number) =>
  (await db.one(
    from("folders")
      .where(q => q("user_id").equals(userId))
      .where(q => q("federation_id").equals(federationId))
      .where(q => q("federation_role").equals("contribution"))
      .where(q => q("deleted_at").isNull())
      .select("id", "federation_quota_bytes"),
  )) as { id: number; federation_quota_bytes: number | string } | null

const localStorageKeyForFedBlob = (userId: number, blobId: string, shardIndex: number | null) => {
  const suffix = shardIndex === null ? "blob" : `shard-${shardIndex}`
  return `u${userId}/fed/${blobId}/${suffix}`
}

// Pushes bytes to a peer's blob receiver. Returns true on success. Failures
// are logged but not rethrown — the caller decides whether the placement is
// viable with the remaining successes.
const pushBlobToPeer = async (
  db: Connection,
  baseUrl: string,
  fedSlug: string,
  blobId: string,
  shardIndex: number | null,
  bytes: Uint8Array,
  meta: {
    owner_pubkey: string
    size: number
    total_size: number
    shard_k?: number
    shard_m?: number
    encrypted_metadata: string | null
  },
): Promise<boolean> => {
  const path =
    shardIndex === null
      ? `/federation/blob/${encodeURIComponent(fedSlug)}/${blobId}`
      : `/federation/shard/${encodeURIComponent(fedSlug)}/${blobId}/${shardIndex}`
  try {
    const res = await peerFetch(db, baseUrl, path, {
      method: "PUT",
      body: bytes,
      headers: {
        "content-type": "application/octet-stream",
        "x-fed-owner-pubkey": meta.owner_pubkey,
        "x-fed-size": String(meta.size),
        "x-fed-total-size": String(meta.total_size),
        ...(meta.shard_k != null ? { "x-fed-shard-k": String(meta.shard_k) } : {}),
        ...(meta.shard_m != null ? { "x-fed-shard-m": String(meta.shard_m) } : {}),
        ...(meta.encrypted_metadata ? { "x-fed-meta": meta.encrypted_metadata } : {}),
      },
    })
    return res.ok
  } catch (err) {
    console.error(`[federation] push to ${baseUrl}${path} failed:`, err)
    return false
  }
}

const fetchBlobFromPeer = async (
  db: Connection,
  baseUrl: string,
  fedSlug: string,
  blobId: string,
  shardIndex: number | null,
): Promise<Uint8Array | null> => {
  const path =
    shardIndex === null
      ? `/federation/blob/${encodeURIComponent(fedSlug)}/${blobId}`
      : `/federation/shard/${encodeURIComponent(fedSlug)}/${blobId}/${shardIndex}`
  try {
    const res = await peerFetch(db, baseUrl, path, { method: "GET" })
    if (!res.ok) return null
    return new Uint8Array(await res.arrayBuffer())
  } catch (err) {
    console.error(`[federation] fetch from ${baseUrl}${path} failed:`, err)
    return null
  }
}

const dropBlobOnPeer = async (
  db: Connection,
  baseUrl: string,
  fedSlug: string,
  blobId: string,
  shardIndex: number | null,
): Promise<void> => {
  const path =
    shardIndex === null
      ? `/federation/blob/${encodeURIComponent(fedSlug)}/${blobId}`
      : `/federation/shard/${encodeURIComponent(fedSlug)}/${blobId}/${shardIndex}`
  try {
    await peerFetch(db, baseUrl, path, { method: "DELETE" })
  } catch (err) {
    console.error(`[federation] delete on ${baseUrl}${path} failed:`, err)
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Content-sharing upload + fetch
// ──────────────────────────────────────────────────────────────────────────

type UploadResult = {
  blob_id: string
  size: number
  placements: number
  short_by: number
  file_id: number | null
}

const encryptedFileMeta = (groupKey: Buffer, meta: { name: string; mime: string; size: number }): string => {
  const sealed = aesGcmEncrypt(groupKey, JSON.stringify(meta))
  return JSON.stringify(sealed)
}

const _decryptFileMeta = (groupKey: Buffer, encrypted: string): { name: string; mime: string; size: number } | null => {
  try {
    const sealed = JSON.parse(encrypted) as { ciphertext: string; iv: string; tag: string }
    const buf = aesGcmDecrypt(groupKey, sealed.ciphertext, sealed.iv, sealed.tag)
    return JSON.parse(buf.toString("utf-8")) as { name: string; mime: string; size: number }
  } catch {
    return null
  }
}

const uploadContentSharing = async (
  db: Connection,
  store: StorageHandle,
  fed: FederationRow,
  userId: number,
  folderId: number,
  fileName: string,
  fileMime: string,
  bytes: Uint8Array,
): Promise<UploadResult> => {
  const groupKey = await openGroupKey(db, fed)
  const blobId = randomUUID()
  const sealed = aesGcmEncrypt(groupKey, bytes)
  // We carry iv/tag inline at the front: 12 bytes iv | 16 bytes tag | ciphertext
  const ivBuf = Buffer.from(sealed.iv, "base64url")
  const tagBuf = Buffer.from(sealed.tag, "base64url")
  const cipherBuf = Buffer.from(sealed.ciphertext, "base64url")
  const payload = new Uint8Array(ivBuf.length + tagBuf.length + cipherBuf.length)
  payload.set(ivBuf, 0)
  payload.set(tagBuf, ivBuf.length)
  payload.set(cipherBuf, ivBuf.length + tagBuf.length)

  const encMeta = encryptedFileMeta(groupKey, { name: fileName, mime: fileMime, size: bytes.length })
  groupKey.fill(0)

  const placement = await selectPlacement(db, fed.id, fed.replication_factor, payload.length)
  const keys = await getInstanceKeys(db)

  let placements = 0
  for (const m of placement.members) {
    if (m.peer_pubkey === keys.ed25519PublicRaw) {
      // Local placement — store on this instance directly.
      const localKey = localStorageKeyForFedBlob(userId, blobId, null)
      await put(store, localKey, payload, "application/octet-stream")
      await db.execute(
        from("federation_blobs").insert({
          federation_id: fed.id,
          blob_id: blobId,
          size: payload.length,
          owner_pubkey: keys.ed25519PublicRaw,
          owner_user_id: userId,
          peer_pubkey: keys.ed25519PublicRaw,
          local_storage_key: localKey,
          encrypted_metadata: encMeta,
        }),
      )
      placements++
    } else {
      const ok = await pushBlobToPeer(db, m.peer_base_url, fed.slug, blobId, null, payload, {
        owner_pubkey: keys.ed25519PublicRaw,
        size: payload.length,
        total_size: bytes.length,
        encrypted_metadata: encMeta,
      })
      if (ok) {
        await db.execute(
          from("federation_blobs").insert({
            federation_id: fed.id,
            blob_id: blobId,
            size: payload.length,
            owner_pubkey: keys.ed25519PublicRaw,
            owner_user_id: userId,
            peer_pubkey: m.peer_pubkey,
            local_storage_key: null,
            encrypted_metadata: encMeta,
          }),
        )
        placements++
      }
    }
  }

  // Materialize a row in `files` so the regular listing/UI/WebDAV path sees
  // the file. storage_key uses the fed: sentinel; readers detect this and
  // route through the federation fetch path instead of the local store.
  const fileRow = (await db.execute(
    from("files")
      .insert({
        user_id: userId,
        folder_id: folderId,
        name: fileName,
        mime: fileMime,
        size: bytes.length,
        storage_key: FED_KEY(fed.id, blobId),
        thumb_key: null,
        version: 1,
      })
      .returning("id"),
  )) as Array<{ id: number }>

  await db.execute({
    text: `UPDATE federation_blobs SET file_id = $1 WHERE federation_id = $2 AND blob_id = $3 AND owner_user_id = $4`,
    values: [fileRow[0]!.id, fed.id, blobId, userId],
  })

  return { blob_id: blobId, size: bytes.length, placements, short_by: placement.shortBy, file_id: fileRow[0]!.id }
}

const fetchContentSharing = async (
  db: Connection,
  store: StorageHandle,
  fed: FederationRow,
  blobId: string,
): Promise<Uint8Array | null> => {
  // Try local first.
  const local = (await db.one(
    from("federation_blobs")
      .where(q => q("federation_id").equals(fed.id))
      .where(q => q("blob_id").equals(blobId))
      .where(q => q("local_storage_key").isNotNull())
      .select("local_storage_key"),
  )) as { local_storage_key: string } | null

  let payload: Uint8Array | null = null
  if (local?.local_storage_key) {
    const res = await fetchObject(store, local.local_storage_key)
    payload = new Uint8Array(await res.arrayBuffer())
  } else {
    // Walk remote placements.
    const remotes = (await db.all(
      from("federation_blobs")
        .where(q => q("federation_id").equals(fed.id))
        .where(q => q("blob_id").equals(blobId))
        .where(q => q("local_storage_key").isNull())
        .select("peer_pubkey"),
    )) as Array<{ peer_pubkey: string }>
    for (const r of remotes) {
      const member = (await db.one(
        from("federation_members")
          .where(q => q("federation_id").equals(fed.id))
          .where(q => q("peer_pubkey").equals(r.peer_pubkey))
          .where(q => q("is_local").equals(false))
          .select("peer_base_url"),
      )) as { peer_base_url: string } | null
      if (!member) continue
      const bytes = await fetchBlobFromPeer(db, member.peer_base_url, fed.slug, blobId, null)
      if (bytes) {
        payload = bytes
        break
      }
    }
  }
  if (!payload) return null

  const groupKey = await openGroupKey(db, fed)
  try {
    const iv = payload.subarray(0, 12)
    const tag = payload.subarray(12, 28)
    const cipher = payload.subarray(28)
    const plaintext = aesGcmDecrypt(
      groupKey,
      Buffer.from(cipher).toString("base64url"),
      Buffer.from(iv).toString("base64url"),
      Buffer.from(tag).toString("base64url"),
    )
    return new Uint8Array(plaintext)
  } finally {
    groupKey.fill(0)
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Space-offering upload + fetch (sharded; see erasure.ts)
// ──────────────────────────────────────────────────────────────────────────

const uploadSpaceOffering = async (
  db: Connection,
  store: StorageHandle,
  fed: FederationRow,
  userId: number,
  folderId: number,
  fileName: string,
  fileMime: string,
  bytes: Uint8Array,
): Promise<UploadResult> => {
  const k = fed.erasure_k ?? 10
  const m = fed.erasure_m ?? 16
  const cfg = erasureConfig(k, m)

  // Per-file symmetric key — owner-held; we encrypt then shard the ciphertext.
  const fileKey = generateSymmetricKey()
  const sealed = aesGcmEncrypt(fileKey, bytes)
  const ivBuf = Buffer.from(sealed.iv, "base64url")
  const tagBuf = Buffer.from(sealed.tag, "base64url")
  const cipherBuf = Buffer.from(sealed.ciphertext, "base64url")
  const ciphertext = new Uint8Array(ivBuf.length + tagBuf.length + cipherBuf.length)
  ciphertext.set(ivBuf, 0)
  ciphertext.set(tagBuf, ivBuf.length)
  ciphertext.set(cipherBuf, ivBuf.length + tagBuf.length)

  const shards = encode(ciphertext, cfg.k, cfg.r)
  const blobId = randomUUID()
  const keys = await getInstanceKeys(db)

  // Owner keeps the file-key encrypted to their own x25519 pubkey. Without
  // a separate per-user X25519 keypair, we use the instance one — losing
  // the instance keys means losing the federation files held by users on
  // this server. Documented in FEDERATION.md as an open question.
  const fileKeySealed = sealForX25519(keys.x25519PublicRaw, fileKey)
  fileKey.fill(0)

  const encMeta = JSON.stringify({
    name: fileName,
    mime: fileMime,
    size: bytes.length,
    ciphertext_size: ciphertext.length,
    file_key_sealed: fileKeySealed,
  })

  // Each shard gets its own placement decision so we spread the load.
  let placements = 0
  let shortBy = 0
  for (const shard of shards) {
    const placement = await selectPlacement(db, fed.id, 1, shard.size)
    const m = placement.members[0]
    if (!m) {
      shortBy++
      continue
    }

    if (m.peer_pubkey === keys.ed25519PublicRaw) {
      const localKey = localStorageKeyForFedBlob(userId, blobId, shard.index)
      await put(store, localKey, shard.bytes, "application/octet-stream")
      await db.execute(
        from("federation_shards").insert({
          federation_id: fed.id,
          blob_id: blobId,
          shard_index: shard.index,
          shard_k: cfg.k,
          shard_m: cfg.totalShards,
          size: shard.size,
          total_size: ciphertext.length,
          owner_pubkey: keys.ed25519PublicRaw,
          owner_user_id: userId,
          peer_pubkey: keys.ed25519PublicRaw,
          local_storage_key: localKey,
          encrypted_metadata: encMeta,
        }),
      )
      placements++
    } else {
      const ok = await pushBlobToPeer(db, m.peer_base_url, fed.slug, blobId, shard.index, shard.bytes, {
        owner_pubkey: keys.ed25519PublicRaw,
        size: shard.size,
        total_size: ciphertext.length,
        shard_k: cfg.k,
        shard_m: cfg.totalShards,
        encrypted_metadata: encMeta,
      })
      if (ok) {
        await db.execute(
          from("federation_shards").insert({
            federation_id: fed.id,
            blob_id: blobId,
            shard_index: shard.index,
            shard_k: cfg.k,
            shard_m: cfg.totalShards,
            size: shard.size,
            total_size: ciphertext.length,
            owner_pubkey: keys.ed25519PublicRaw,
            owner_user_id: userId,
            peer_pubkey: m.peer_pubkey,
            local_storage_key: null,
            encrypted_metadata: encMeta,
          }),
        )
        placements++
      } else {
        shortBy++
      }
    }
  }

  const fileRow = (await db.execute(
    from("files")
      .insert({
        user_id: userId,
        folder_id: folderId,
        name: fileName,
        mime: fileMime,
        size: bytes.length,
        storage_key: FED_SHARD_KEY(fed.id, blobId),
        thumb_key: null,
        version: 1,
      })
      .returning("id"),
  )) as Array<{ id: number }>

  await db.execute({
    text: `UPDATE federation_shards SET file_id = $1 WHERE federation_id = $2 AND blob_id = $3 AND owner_user_id = $4`,
    values: [fileRow[0]!.id, fed.id, blobId, userId],
  })

  return { blob_id: blobId, size: bytes.length, placements, short_by: shortBy, file_id: fileRow[0]!.id }
}

const fetchSpaceOffering = async (
  db: Connection,
  store: StorageHandle,
  fed: FederationRow,
  blobId: string,
): Promise<Uint8Array | null> => {
  const shards = (await db.all(
    from("federation_shards")
      .where(q => q("federation_id").equals(fed.id))
      .where(q => q("blob_id").equals(blobId))
      .orderBy("shard_index", "ASC"),
  )) as Array<{
    shard_index: number
    shard_k: number
    shard_m: number
    total_size: number | string
    peer_pubkey: string
    local_storage_key: string | null
    encrypted_metadata: string | null
  }>
  if (shards.length === 0) return null

  const k = shards[0]!.shard_k
  const m = shards[0]!.shard_m
  const r = Math.max(1, Math.ceil(m / k))
  const totalSize = Number(shards[0]!.total_size)

  // Fetch one shard per fragment.
  const collected: Array<{ index: number; bytes: Uint8Array }> = []
  const seenFragments = new Set<number>()
  for (const s of shards) {
    const fragIdx = Math.floor(s.shard_index / r)
    if (seenFragments.has(fragIdx)) continue
    let bytes: Uint8Array | null = null
    if (s.local_storage_key) {
      const res = await fetchObject(store, s.local_storage_key)
      bytes = new Uint8Array(await res.arrayBuffer())
    } else {
      const peer = (await db.one(
        from("federation_members")
          .where(q => q("federation_id").equals(fed.id))
          .where(q => q("peer_pubkey").equals(s.peer_pubkey))
          .where(q => q("is_local").equals(false))
          .select("peer_base_url"),
      )) as { peer_base_url: string } | null
      if (peer) bytes = await fetchBlobFromPeer(db, peer.peer_base_url, fed.slug, blobId, s.shard_index)
    }
    if (bytes) {
      collected.push({ index: s.shard_index, bytes })
      seenFragments.add(fragIdx)
      if (seenFragments.size === k) break
    }
  }
  if (seenFragments.size < k) return null

  const ciphertext = decode(collected, k, r, totalSize)

  // Decrypt with the owner's file key (sealed in encrypted_metadata).
  const encMetaStr = shards[0]!.encrypted_metadata
  if (!encMetaStr) return null
  const encMeta = JSON.parse(encMetaStr) as { file_key_sealed: string }
  const keys = await getInstanceKeys(db)
  let fileKey: Buffer
  try {
    fileKey = openSealedX25519(keys.x25519PrivatePem, encMeta.file_key_sealed)
  } catch {
    return null
  }
  try {
    const iv = ciphertext.subarray(0, 12)
    const tag = ciphertext.subarray(12, 28)
    const cipher = ciphertext.subarray(28)
    const plaintext = aesGcmDecrypt(
      fileKey,
      Buffer.from(cipher).toString("base64url"),
      Buffer.from(iv).toString("base64url"),
      Buffer.from(tag).toString("base64url"),
    )
    return new Uint8Array(plaintext)
  } finally {
    fileKey.fill(0)
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Storage-key routing — called by src/files routes to handle fed: keys
// ──────────────────────────────────────────────────────────────────────────

export const isFederationKey = (storageKey: string): boolean =>
  storageKey.startsWith("fed:") || storageKey.startsWith("fed-shard:")

export const fetchFederationBytes = async (
  db: Connection,
  store: StorageHandle,
  storageKey: string,
): Promise<Uint8Array | null> => {
  let federationId: number
  let blobId: string
  let isShard: boolean
  if (storageKey.startsWith("fed-shard:")) {
    isShard = true
    const rest = storageKey.slice("fed-shard:".length)
    const [fid, bid] = rest.split(":")
    federationId = Number(fid)
    blobId = bid!
  } else if (storageKey.startsWith("fed:")) {
    isShard = false
    const rest = storageKey.slice("fed:".length)
    const [fid, bid] = rest.split(":")
    federationId = Number(fid)
    blobId = bid!
  } else {
    return null
  }
  const fed = await federationById(db, federationId)
  if (!fed) return null
  return isShard ? await fetchSpaceOffering(db, store, fed, blobId) : await fetchContentSharing(db, store, fed, blobId)
}

export const dropFederationBlob = async (db: Connection, store: StorageHandle, storageKey: string): Promise<void> => {
  let federationId: number
  let blobId: string
  let isShard: boolean
  if (storageKey.startsWith("fed-shard:")) {
    isShard = true
    const rest = storageKey.slice("fed-shard:".length)
    const [fid, bid] = rest.split(":")
    federationId = Number(fid)
    blobId = bid!
  } else if (storageKey.startsWith("fed:")) {
    isShard = false
    const rest = storageKey.slice("fed:".length)
    const [fid, bid] = rest.split(":")
    federationId = Number(fid)
    blobId = bid!
  } else {
    return
  }

  const fed = await federationById(db, federationId)
  if (!fed) return

  if (isShard) {
    const shards = (await db.all(
      from("federation_shards")
        .where(q => q("federation_id").equals(federationId))
        .where(q => q("blob_id").equals(blobId)),
    )) as Array<{ shard_index: number; peer_pubkey: string; local_storage_key: string | null }>
    for (const s of shards) {
      if (s.local_storage_key) {
        await drop(store, s.local_storage_key).catch(() => {})
      } else {
        const peer = (await db.one(
          from("federation_members")
            .where(q => q("federation_id").equals(federationId))
            .where(q => q("peer_pubkey").equals(s.peer_pubkey))
            .where(q => q("is_local").equals(false))
            .select("peer_base_url"),
        )) as { peer_base_url: string } | null
        if (peer) await dropBlobOnPeer(db, peer.peer_base_url, fed.slug, blobId, s.shard_index)
      }
    }
    await db.execute(
      from("federation_shards")
        .where(q => q("federation_id").equals(federationId))
        .where(q => q("blob_id").equals(blobId))
        .del(),
    )
  } else {
    const placements = (await db.all(
      from("federation_blobs")
        .where(q => q("federation_id").equals(federationId))
        .where(q => q("blob_id").equals(blobId)),
    )) as Array<{ peer_pubkey: string; local_storage_key: string | null }>
    for (const p of placements) {
      if (p.local_storage_key) {
        await drop(store, p.local_storage_key).catch(() => {})
      } else {
        const peer = (await db.one(
          from("federation_members")
            .where(q => q("federation_id").equals(federationId))
            .where(q => q("peer_pubkey").equals(p.peer_pubkey))
            .where(q => q("is_local").equals(false))
            .select("peer_base_url"),
        )) as { peer_base_url: string } | null
        if (peer) await dropBlobOnPeer(db, peer.peer_base_url, fed.slug, blobId, null)
      }
    }
    await db.execute(
      from("federation_blobs")
        .where(q => q("federation_id").equals(federationId))
        .where(q => q("blob_id").equals(blobId))
        .del(),
    )
  }
}

// ──────────────────────────────────────────────────────────────────────────
// User-facing federation file routes
// ──────────────────────────────────────────────────────────────────────────

export const federationFilesRoutes = (db: Connection, secret: string, store: StorageHandle) => {
  const gate = requireSettingEnabled(db, SETTING_FEDERATION_ENABLED)
  const upload = pipeline(gate, requireAuth({ secret, db }), parseMultipart)
  const guard = pipeline(gate, requireAuth({ secret, db }))
  // Receiver endpoints also need the gate — a disabled federation must
  // reject peer traffic, not silently swallow blobs.
  const receiver = pipeline(gate, requirePeerSignature())

  return [
    // User uploads a file into a federation. Body is multipart with a
    // single file. The destination folder must be a federation-tied
    // folder; we use the user's contribution folder for both modes (in
    // content-sharing mode the user's mount folder also works).
    post(
      "/me/federations/:id/files",
      upload(async c => {
        const userId = authId(c)
        const fedId = Number(c.params.id)
        const fed = await federationById(db, fedId)
        if (!fed) return json(c, 404, { error: "Federation not found" })
        const member = await localMemberFor(db, fedId, userId)
        if (!member) return json(c, 404, { error: "Federation not found" })

        const body = c.body as { fields: Record<string, string>; files: Record<string, Blob & { name?: string }> }
        const entries = Object.values(body?.files ?? {})
        if (entries.length === 0) return json(c, 422, { error: "No file uploaded" })

        const targetFolderId = body.fields?.folder_id ?? body.fields?.folderId
        const folderId = targetFolderId ? Number(targetFolderId) : null

        const folder = folderId
          ? ((await db.one(
              from("folders")
                .where(q => q("id").equals(folderId))
                .where(q => q("user_id").equals(userId))
                .where(q => q("federation_id").equals(fedId))
                .where(q => q("deleted_at").isNull()),
            )) as { id: number; federation_role: string } | null)
          : null
        if (!folder) return json(c, 422, { error: "Target folder_id must be a federation folder you own" })

        const allowance = Math.floor(Number(member.contributed_bytes) * (Number(fed.quota_multiplier) || 1))
        const incoming = entries.reduce((acc, f) => acc + (f.size ?? 0), 0)
        if (allowance > 0 && Number(member.used_bytes) + incoming > allowance) {
          return json(c, 402, {
            error: "Federation quota exceeded",
            allowance_bytes: allowance,
            used_bytes: Number(member.used_bytes),
            attempted_bytes: incoming,
          })
        }

        const results: UploadResult[] = []
        for (const file of entries) {
          const bytes = new Uint8Array(await file.arrayBuffer())
          const name = (file as any).name ?? "upload.bin"
          const mime = file.type || "application/octet-stream"
          const result =
            fed.type === "content-sharing"
              ? await uploadContentSharing(db, store, fed, userId, folder.id, name, mime, bytes)
              : await uploadSpaceOffering(db, store, fed, userId, folder.id, name, mime, bytes)
          results.push(result)
          await db.execute({
            text: `UPDATE federation_members SET used_bytes = used_bytes + $1 WHERE id = $2`,
            values: [bytes.length, member.id],
          })
        }
        return json(c, 201, { results })
      }),
    ),

    get(
      "/me/federations/:id/files/:blob_id/download",
      guard(async c => {
        const userId = authId(c)
        const fedId = Number(c.params.id)
        const blobId = c.params.blob_id
        const fed = await federationById(db, fedId)
        if (!fed) return json(c, 404, { error: "Federation not found" })
        const member = await localMemberFor(db, fedId, userId)
        if (!member) return json(c, 404, { error: "Federation not found" })

        const bytes =
          fed.type === "content-sharing"
            ? await fetchContentSharing(db, store, fed, blobId)
            : await fetchSpaceOffering(db, store, fed, blobId)
        if (!bytes) return json(c, 404, { error: "Blob not found or unrecoverable" })

        // Find a corresponding file row for content-disposition naming.
        const row = (await db.one(
          from("files")
            .where(q =>
              q("storage_key").equals(
                fed.type === "content-sharing" ? FED_KEY(fed.id, blobId) : FED_SHARD_KEY(fed.id, blobId),
              ),
            )
            .select("name", "mime"),
        )) as { name: string; mime: string } | null

        const ct = row?.mime ?? "application/octet-stream"
        const name = row?.name ?? blobId
        const headered = putHeader(
          putHeader(
            putHeader(c, "content-type", ct),
            "content-disposition",
            `attachment; filename="${name.replace(/"/g, "_")}"`,
          ),
          "content-length",
          String(bytes.length),
        )
        const rs = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes)
            controller.close()
          },
        })
        return stream(headered, 200, rs)
      }),
    ),

    del(
      "/me/federations/:id/files/:blob_id",
      guard(async c => {
        const userId = authId(c)
        const fedId = Number(c.params.id)
        const blobId = c.params.blob_id
        const fed = await federationById(db, fedId)
        if (!fed) return json(c, 404, { error: "Federation not found" })
        const member = await localMemberFor(db, fedId, userId)
        if (!member) return json(c, 404, { error: "Federation not found" })

        const storageKey = fed.type === "content-sharing" ? FED_KEY(fed.id, blobId) : FED_SHARD_KEY(fed.id, blobId)
        const row = (await db.one(
          from("files")
            .where(q => q("storage_key").equals(storageKey))
            .where(q => q("user_id").equals(userId))
            .select("id", "size"),
        )) as { id: number; size: number | string } | null
        if (!row) return json(c, 404, { error: "File not found" })

        await dropFederationBlob(db, store, storageKey)
        await db.execute(
          from("files")
            .where(q => q("id").equals(row.id))
            .del(),
        )
        await db.execute({
          text: `UPDATE federation_members SET used_bytes = GREATEST(0, used_bytes - $1) WHERE id = $2`,
          values: [Number(row.size), member.id],
        })
        return json(c, 200, { deleted: blobId })
      }),
    ),

    // ────────────────────────────────────────────────────────────────────
    // Peer-to-peer receiver routes (signed peer transport)
    // ────────────────────────────────────────────────────────────────────

    post(
      "/federation/blob/:slug/:blob_id",
      receiver(async c => {
        const slug = c.params.slug
        const blobId = c.params.blob_id
        const fed = await federationBySlug(db, slug)
        if (!fed) return json(c, 404, { error: "Federation not found" })

        const peer = (c.assigns as any).peer as { pubkeyRaw: string; body: Uint8Array }
        const member = await memberForPeer(db, fed.id, peer.pubkeyRaw)
        if (!member || member.status !== "active") return json(c, 403, { error: "Not an active federation peer" })

        const ownerPubkey = c.request.headers.get("x-fed-owner-pubkey")
        const sizeHeader = c.request.headers.get("x-fed-size")
        const encMeta = c.request.headers.get("x-fed-meta")
        if (!ownerPubkey || !sizeHeader) return json(c, 422, { error: "Missing x-fed-owner-pubkey or x-fed-size" })
        const size = Number(sizeHeader)

        // Find our local contribution folder for the owner's user — peers
        // sending blobs don't know our user IDs; we host on behalf of "any
        // user with a contribution folder for this federation," round-robin
        // pick the first one with available capacity.
        const localContrib = (await db.one({
          text: `SELECT f.id, f.user_id, f.federation_quota_bytes
                 FROM folders f
                 JOIN federation_members m ON m.user_id = f.user_id AND m.federation_id = f.federation_id AND m.is_local = TRUE
                WHERE f.federation_id = $1 AND f.federation_role = 'contribution' AND f.deleted_at IS NULL
                  AND m.contributed_bytes - m.used_bytes >= $2
                ORDER BY (m.contributed_bytes - m.used_bytes) DESC
                LIMIT 1`,
          values: [fed.id, size],
        })) as { id: number; user_id: number; federation_quota_bytes: number | string } | null
        if (!localContrib) return json(c, 507, { error: "No local contribution capacity available" })

        const localKey = localStorageKeyForFedBlob(localContrib.user_id, blobId, null)
        await put(store, localKey, peer.body, "application/octet-stream")

        const ownerLocal = await db.one(
          from("users")
            .where(q => q("id").equals(localContrib.user_id))
            .select("id"),
        )
        const keys = await getInstanceKeys(db)
        try {
          await db.execute(
            from("federation_blobs").insert({
              federation_id: fed.id,
              blob_id: blobId,
              size,
              owner_pubkey: ownerPubkey,
              owner_user_id: null,
              peer_pubkey: keys.ed25519PublicRaw,
              local_storage_key: localKey,
              encrypted_metadata: encMeta,
            }),
          )
        } catch {
          // Duplicate placement — already had it. Drop the new bytes.
          await drop(store, localKey).catch(() => {})
        }
        await db.execute({
          text: `UPDATE federation_members SET used_bytes = used_bytes + $1 WHERE federation_id = $2 AND user_id = $3 AND is_local = TRUE`,
          values: [size, fed.id, localContrib.user_id],
        })

        return json(c, 200, { stored: blobId, host_user: ownerLocal ? localContrib.user_id : null })
      }),
    ),

    get(
      "/federation/blob/:slug/:blob_id",
      receiver(async c => {
        const slug = c.params.slug
        const blobId = c.params.blob_id
        const fed = await federationBySlug(db, slug)
        if (!fed) return json(c, 404, { error: "Federation not found" })

        const peer = (c.assigns as any).peer as { pubkeyRaw: string }
        const member = await memberForPeer(db, fed.id, peer.pubkeyRaw)
        if (!member || member.status !== "active") return json(c, 403, { error: "Not an active federation peer" })

        const placement = (await db.one(
          from("federation_blobs")
            .where(q => q("federation_id").equals(fed.id))
            .where(q => q("blob_id").equals(blobId))
            .where(q => q("local_storage_key").isNotNull())
            .select("local_storage_key"),
        )) as { local_storage_key: string } | null
        if (!placement) return json(c, 404, { error: "Blob not held locally" })
        const res = await fetchObject(store, placement.local_storage_key)
        return stream(putHeader(c, "content-type", "application/octet-stream"), 200, res.body!)
      }),
    ),

    del(
      "/federation/blob/:slug/:blob_id",
      receiver(async c => {
        const slug = c.params.slug
        const blobId = c.params.blob_id
        const fed = await federationBySlug(db, slug)
        if (!fed) return json(c, 404, { error: "Federation not found" })
        const peer = (c.assigns as any).peer as { pubkeyRaw: string }
        const member = await memberForPeer(db, fed.id, peer.pubkeyRaw)
        if (!member || member.status !== "active") return json(c, 403, { error: "Not an active federation peer" })

        // Only the owner of a blob may instruct deletion.
        const row = (await db.one(
          from("federation_blobs")
            .where(q => q("federation_id").equals(fed.id))
            .where(q => q("blob_id").equals(blobId))
            .where(q => q("local_storage_key").isNotNull())
            .select("local_storage_key", "owner_pubkey", "size"),
        )) as { local_storage_key: string; owner_pubkey: string; size: number | string } | null
        if (!row) return json(c, 404, { error: "Blob not held locally" })
        if (row.owner_pubkey !== peer.pubkeyRaw) return json(c, 403, { error: "Only the owner can delete" })

        await drop(store, row.local_storage_key).catch(() => {})
        const selfPubkey = (await getInstanceKeys(db)).ed25519PublicRaw
        await db.execute(
          from("federation_blobs")
            .where(q => q("federation_id").equals(fed.id))
            .where(q => q("blob_id").equals(blobId))
            .where(q => q("peer_pubkey").equals(selfPubkey))
            .del(),
        )
        return json(c, 200, { deleted: blobId })
      }),
    ),

    // Shard variants — same semantics as blob but include shard_index in path.
    post(
      "/federation/shard/:slug/:blob_id/:shard_index",
      receiver(async c => {
        const slug = c.params.slug
        const blobId = c.params.blob_id
        const shardIndex = Number(c.params.shard_index)
        const fed = await federationBySlug(db, slug)
        if (!fed) return json(c, 404, { error: "Federation not found" })
        const peer = (c.assigns as any).peer as { pubkeyRaw: string; body: Uint8Array }
        const member = await memberForPeer(db, fed.id, peer.pubkeyRaw)
        if (!member || member.status !== "active") return json(c, 403, { error: "Not an active federation peer" })

        const ownerPubkey = c.request.headers.get("x-fed-owner-pubkey")
        const sizeHeader = c.request.headers.get("x-fed-size")
        const totalSize = c.request.headers.get("x-fed-total-size")
        const k = c.request.headers.get("x-fed-shard-k")
        const m = c.request.headers.get("x-fed-shard-m")
        const encMeta = c.request.headers.get("x-fed-meta")
        if (!ownerPubkey || !sizeHeader || !totalSize || !k || !m) {
          return json(c, 422, { error: "Missing shard headers" })
        }
        const size = Number(sizeHeader)

        const localContrib = (await db.one({
          text: `SELECT f.id, f.user_id
                 FROM folders f
                 JOIN federation_members m ON m.user_id = f.user_id AND m.federation_id = f.federation_id AND m.is_local = TRUE
                WHERE f.federation_id = $1 AND f.federation_role = 'contribution' AND f.deleted_at IS NULL
                  AND m.contributed_bytes - m.used_bytes >= $2
                ORDER BY (m.contributed_bytes - m.used_bytes) DESC
                LIMIT 1`,
          values: [fed.id, size],
        })) as { id: number; user_id: number } | null
        if (!localContrib) return json(c, 507, { error: "No local contribution capacity" })

        const localKey = localStorageKeyForFedBlob(localContrib.user_id, blobId, shardIndex)
        await put(store, localKey, peer.body, "application/octet-stream")

        const keys = await getInstanceKeys(db)
        try {
          await db.execute(
            from("federation_shards").insert({
              federation_id: fed.id,
              blob_id: blobId,
              shard_index: shardIndex,
              shard_k: Number(k),
              shard_m: Number(m),
              size,
              total_size: Number(totalSize),
              owner_pubkey: ownerPubkey,
              owner_user_id: null,
              peer_pubkey: keys.ed25519PublicRaw,
              local_storage_key: localKey,
              encrypted_metadata: encMeta,
            }),
          )
        } catch {
          await drop(store, localKey).catch(() => {})
        }
        await db.execute({
          text: `UPDATE federation_members SET used_bytes = used_bytes + $1 WHERE federation_id = $2 AND user_id = $3 AND is_local = TRUE`,
          values: [size, fed.id, localContrib.user_id],
        })
        return json(c, 200, { stored: blobId, shard_index: shardIndex })
      }),
    ),

    get(
      "/federation/shard/:slug/:blob_id/:shard_index",
      receiver(async c => {
        const slug = c.params.slug
        const blobId = c.params.blob_id
        const shardIndex = Number(c.params.shard_index)
        const fed = await federationBySlug(db, slug)
        if (!fed) return json(c, 404, { error: "Federation not found" })
        const peer = (c.assigns as any).peer as { pubkeyRaw: string }
        const member = await memberForPeer(db, fed.id, peer.pubkeyRaw)
        if (!member || member.status !== "active") return json(c, 403, { error: "Not an active federation peer" })

        const placement = (await db.one(
          from("federation_shards")
            .where(q => q("federation_id").equals(fed.id))
            .where(q => q("blob_id").equals(blobId))
            .where(q => q("shard_index").equals(shardIndex))
            .where(q => q("local_storage_key").isNotNull())
            .select("local_storage_key"),
        )) as { local_storage_key: string } | null
        if (!placement) return json(c, 404, { error: "Shard not held locally" })
        const res = await fetchObject(store, placement.local_storage_key)
        return stream(putHeader(c, "content-type", "application/octet-stream"), 200, res.body!)
      }),
    ),

    del(
      "/federation/shard/:slug/:blob_id/:shard_index",
      receiver(async c => {
        const slug = c.params.slug
        const blobId = c.params.blob_id
        const shardIndex = Number(c.params.shard_index)
        const fed = await federationBySlug(db, slug)
        if (!fed) return json(c, 404, { error: "Federation not found" })
        const peer = (c.assigns as any).peer as { pubkeyRaw: string }
        const member = await memberForPeer(db, fed.id, peer.pubkeyRaw)
        if (!member || member.status !== "active") return json(c, 403, { error: "Not an active federation peer" })

        const row = (await db.one(
          from("federation_shards")
            .where(q => q("federation_id").equals(fed.id))
            .where(q => q("blob_id").equals(blobId))
            .where(q => q("shard_index").equals(shardIndex))
            .select("local_storage_key", "owner_pubkey", "size"),
        )) as { local_storage_key: string | null; owner_pubkey: string; size: number | string } | null
        if (!row?.local_storage_key) return json(c, 404, { error: "Shard not held locally" })
        if (row.owner_pubkey !== peer.pubkeyRaw) return json(c, 403, { error: "Only the owner can delete" })

        await drop(store, row.local_storage_key).catch(() => {})
        const selfShardKey = (await getInstanceKeys(db)).ed25519PublicRaw
        await db.execute(
          from("federation_shards")
            .where(q => q("federation_id").equals(fed.id))
            .where(q => q("blob_id").equals(blobId))
            .where(q => q("shard_index").equals(shardIndex))
            .where(q => q("peer_pubkey").equals(selfShardKey))
            .del(),
        )
        return json(c, 200, { deleted: blobId, shard_index: shardIndex })
      }),
    ),
  ]
}

// ──────────────────────────────────────────────────────────────────────────
// Drain sweep — re-replicate blobs we host for draining peers OR move our
// blobs off draining local members. Best-effort; runs from server.ts.
// ──────────────────────────────────────────────────────────────────────────

export const sweepFederationDrains = async (db: Connection, store: StorageHandle): Promise<void> => {
  const draining = (await db.all(
    from("federation_members")
      .where(q => q("status").equals("draining"))
      .select("id", "federation_id", "user_id", "peer_pubkey", "is_local"),
  )) as Array<{ id: number; federation_id: number; user_id: number | null; peer_pubkey: string; is_local: boolean }>

  for (const m of draining) {
    // Look for any blobs/shards held by THIS peer-pubkey. Re-replicate
    // each to a different peer with capacity. Once nothing is held, mark
    // status = 'left'.
    const blobs = (await db.all(
      from("federation_blobs")
        .where(q => q("federation_id").equals(m.federation_id))
        .where(q => q("peer_pubkey").equals(m.peer_pubkey))
        .select("id", "blob_id", "size", "owner_pubkey", "local_storage_key", "encrypted_metadata"),
    )) as Array<{
      id: number
      blob_id: string
      size: number | string
      owner_pubkey: string
      local_storage_key: string | null
      encrypted_metadata: string | null
    }>

    const shards = (await db.all(
      from("federation_shards")
        .where(q => q("federation_id").equals(m.federation_id))
        .where(q => q("peer_pubkey").equals(m.peer_pubkey))
        .select(
          "id",
          "blob_id",
          "shard_index",
          "shard_k",
          "shard_m",
          "size",
          "total_size",
          "owner_pubkey",
          "local_storage_key",
          "encrypted_metadata",
        ),
    )) as Array<{
      id: number
      blob_id: string
      shard_index: number
      shard_k: number
      shard_m: number
      size: number | string
      total_size: number | string
      owner_pubkey: string
      local_storage_key: string | null
      encrypted_metadata: string | null
    }>

    const fed = await federationById(db, m.federation_id)
    if (!fed) continue

    for (const b of blobs) {
      const peers = await selectPlacement(db, fed.id, 1, Number(b.size), new Set([m.peer_pubkey]))
      const target = peers.members[0]
      if (!target) continue
      let bytes: Uint8Array | null = null
      if (b.local_storage_key) {
        try {
          const res = await fetchObject(store, b.local_storage_key)
          bytes = new Uint8Array(await res.arrayBuffer())
        } catch {
          bytes = null
        }
      }
      if (!bytes) continue // we don't hold the bytes; can't move them
      const keys = await getInstanceKeys(db)
      if (target.peer_pubkey === keys.ed25519PublicRaw) {
        // Already us — keep the row, just clear the draining marker.
        continue
      }
      const ok = await pushBlobToPeer(db, target.peer_base_url, fed.slug, b.blob_id, null, bytes, {
        owner_pubkey: b.owner_pubkey,
        size: Number(b.size),
        total_size: Number(b.size),
        encrypted_metadata: b.encrypted_metadata,
      })
      if (ok) {
        await db.execute(
          from("federation_blobs")
            .where(q => q("id").equals(b.id))
            .update({ peer_pubkey: target.peer_pubkey, local_storage_key: null }),
        )
        if (b.local_storage_key) await drop(store, b.local_storage_key).catch(() => {})
      }
    }

    for (const s of shards) {
      const peers = await selectPlacement(db, fed.id, 1, Number(s.size), new Set([m.peer_pubkey]))
      const target = peers.members[0]
      if (!target) continue
      let bytes: Uint8Array | null = null
      if (s.local_storage_key) {
        try {
          const res = await fetchObject(store, s.local_storage_key)
          bytes = new Uint8Array(await res.arrayBuffer())
        } catch {
          bytes = null
        }
      }
      if (!bytes) continue
      const ok = await pushBlobToPeer(db, target.peer_base_url, fed.slug, s.blob_id, s.shard_index, bytes, {
        owner_pubkey: s.owner_pubkey,
        size: Number(s.size),
        total_size: Number(s.total_size),
        shard_k: s.shard_k,
        shard_m: s.shard_m,
        encrypted_metadata: s.encrypted_metadata,
      })
      if (ok) {
        await db.execute(
          from("federation_shards")
            .where(q => q("id").equals(s.id))
            .update({ peer_pubkey: target.peer_pubkey, local_storage_key: null }),
        )
        if (s.local_storage_key) await drop(store, s.local_storage_key).catch(() => {})
      }
    }

    // Are we done? Anything still held?
    const remainingBlobs = (await db.one(
      from("federation_blobs")
        .where(q => q("federation_id").equals(m.federation_id))
        .where(q => q("peer_pubkey").equals(m.peer_pubkey))
        .select(raw("COUNT(*) AS n") as any),
    )) as { n: number | string } | null
    const remainingShards = (await db.one(
      from("federation_shards")
        .where(q => q("federation_id").equals(m.federation_id))
        .where(q => q("peer_pubkey").equals(m.peer_pubkey))
        .select(raw("COUNT(*) AS n") as any),
    )) as { n: number | string } | null
    const remaining = Number(remainingBlobs?.n ?? 0) + Number(remainingShards?.n ?? 0)
    if (remaining === 0) {
      await db.execute(
        from("federation_members")
          .where(q => q("id").equals(m.id))
          .update({ status: "left" }),
      )
    }
  }
}
