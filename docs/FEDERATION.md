# Federation

**Status:** Implemented (MVP). Off by default — the owner flips **Admin → Settings → Federation** to enable. Once on, any user on the instance can create or accept federations.

Federation lets independent Stohr instances form named, invite-gated networks where members pool storage. A user designates one folder as their contribution to a federation with a quota cap; that folder becomes the local mount point for federated content.

This is **not** an open public network. There is no DHT, no anonymous peers, no presigned URLs to clients. Every peer is a known Stohr instance identified by a public key, and every file operation flows through the existing API.

## Enabling federation

Toggle `federation_enabled` from Admin → Settings, or via the API:

```bash
curl -X PATCH https://your-stohr.example.com/api/admin/settings \
  -H "Authorization: Bearer $OWNER_TOKEN" -H "content-type: application/json" \
  -d '{"federation_enabled": true}'
```

While the toggle is off, all `/me/federations/*` and peer-to-peer `/federation/*` endpoints return 503. Existing federation rows are preserved when you flip it back on — peers resume traffic at the next request.

## Using federation (UI quickstart)

Once the owner has enabled federation, every user can manage their own federations from **Settings → Federation**. The flow:

### Creating a federation

1. Go to **Settings → Federation** → click **Create federation**.
2. Choose a **slug** (lowercase + hyphens, identifies the federation across peers — can't be changed later).
3. Choose a **type**:
   - **Content-sharing** — group-encrypted; members can browse each other's files.
   - **Space-offering** — end-to-end encrypted; peers host shards they can't read.
4. Set the **replication factor** (how many peers hold each blob; default 3).
5. Click **Create**. You become the federation admin.

### Inviting someone

1. Open the federation from your list, then click **Mint new invite (7 days)**.
2. Copy the invite token (it's shown once — can't be recovered later).
3. Send it to the recipient out-of-band (Signal, email, in person — anything secure-enough).

### Accepting an invite

1. Receive an invite token from the federation's admin.
2. Go to **Settings → Federation** → **Accept invite**.
3. Paste the token, optionally set a display name, click **Accept invite**.
4. The accept handler reaches out to the introducer URL embedded in the token, exchanges keys, and registers you as a member.

### Designating a contribution folder

Every member needs a contribution folder — a regular folder on this instance whose disk space is what you're offering to the federation. From the federation detail view:

1. Click **Designate folder**.
2. Set a **quota in GB** (the maximum disk space this instance will host for the federation).
3. Either pick an existing root-level folder or type a name to create a new dedicated one.
4. Click **Designate folder**.

That folder now stores encrypted blobs (or shards) on behalf of the federation. In content-sharing mode you can also browse the pool from there once we ship the "mount folder" UI in a follow-up.

### Leaving a federation

Open the federation detail → **Leave federation**. This marks you as draining. The background sweep re-replicates blobs you host onto other peers, then removes the membership. Don't shut the instance down until drain completes — you'd lose your peers' data.

### Verifying a peer before you trust them

Each Stohr instance has a unique Ed25519 pubkey (a "fingerprint"). You see yours at the top of **Settings → Federation** — `This instance's pubkey`. Before exchanging an invite with someone, compare fingerprints over a separate channel so you know you're pairing with the right peer.

## Two federation types

Federation has two modes selected at creation. They share the join flow but are otherwise separate protocols — don't try to make one codepath do both.

### Content-sharing federation

A pooled community drive. All members can read, write, and copy any file in the federation.

- **Trust model:** high. Every member can decrypt every file.
- **Encryption:** group key, distributed to members on join via X25519 key exchange. Encryption is for transport and at-rest-on-disk, not zero-knowledge from peers.
- **Replication:** full copies on N peers (default N=3). Any peer can serve any file → fast reads, simple recovery.
- **Use cases:** family, small team, club, co-op.
- **Legal note for hosts:** members host other members' plaintext-readable files. Anyone running a content-sharing federation peer is accepting that exposure.

### Space-offering federation

Pure capacity pooling. Members host encrypted shards they cannot read.

- **Trust model:** zero. Peers hold ciphertext only.
- **Encryption:** client-side end-to-end. Files are encrypted at the source before being sharded. Only the file owner has the decryption key. Federation admins cannot read content.
- **Replication:** Reed-Solomon erasure coding (default 10-of-16). 1 GB of content costs ~1.6 GB of network space and tolerates 6 peers offline.
- **Use cases:** capacity pooling among loose acquaintances or strangers in a known federation.
- **Legal note for hosts:** peers cannot read what they store. Plausible deniability is a deliberate property of this mode.

## Membership

Federations are **named** and **invite-gated**. Each federation has:

- A unique ID and human-readable name
- A signing keypair (Ed25519) — the federation identity
- A list of member instances, each represented by `{ pubkey, base_url, contributed_bytes, used_bytes, joined_at, status }`
- A type (`content-sharing` or `space-offering`)
- Replication parameters (N for content-sharing, K-of-M for space-offering)
- A quota multiplier N (default 1; admins may raise it to overcommit)

### Invite tokens

An invite token is a signed payload:

```
{
  federation_id,
  federation_name,
  federation_type,
  introducer_base_url,
  expires_at,
  nonce
}
```

Signed by the federation's Ed25519 key. The accepting instance verifies the signature against the federation pubkey (delivered out-of-band the first time, or embedded in the token for trust-on-first-use), then performs a pairing handshake with the introducer to establish its own membership.

Tokens are single-use, expire by default in 7 days, and can be revoked by any federation admin before use.

## Folder-as-mount-point

A user joins a federation by:

1. Accepting an invite token (manually, via API or UI)
2. Designating a folder as their federation contribution
3. Setting a quota cap on that folder (e.g. 500 GB)

That folder becomes the local mount point. From the user's perspective:

- **Content-sharing mode:** the folder displays all federation content. Files uploaded here are replicated to N peers; files downloaded come from any available peer.
- **Space-offering mode:** the folder displays the user's own files (which physically live as encrypted shards on peers, not in this folder). The folder's actual disk usage is encrypted shards belonging to *other* members.

The folder cannot be deleted while the federation is active. Removing it requires leaving the federation (see Drain-on-departure).

## Quota model

**Per-user quota = N × (your contributed bytes)**, where N is the federation's quota multiplier.

- **Default N=1:** contribute 500 GB, store 500 GB of your own content. The benefit is durability and off-site replication, not extra capacity.
- **N > 1:** admin opts into overcommitment for capacity pooling. Federation advertises more usable space than the raw math supports, betting statistically that members won't fill quotas simultaneously. The admin accepts the risk: if everyone fills up, writes start failing.

Quotas are always shown to users in absolute bytes, never as a percentage of a fluctuating pool. Joining/leaving members does not change other members' displayed quotas.

### Why not proportional

Proportional quota (you get X% of the pool) was considered and rejected. When a peer leaves, the pool shrinks, and every other member's usable capacity drops without warning. The UX of "your available space just decreased because someone else left" is unacceptable.

## Replication and placement

### Content-sharing

On upload:

1. File is encrypted with the federation group key
2. N peers are selected (preference order: lowest used/contributed ratio, geographic spread, recent uptime)
3. The file is `PUT` to each peer's federation receiver endpoint
4. The local `files` row records the federation ID and the set of peer pubkeys holding copies

On read:

1. Locate the file's peer set
2. Fetch from any available peer (prefer self if local copy exists)
3. Decrypt with the group key

### Space-offering

On upload:

1. File is encrypted client-side with the owner's key
2. Ciphertext is split into K data shards + (M-K) parity shards via Reed-Solomon
3. M peers are selected per the same placement rules as above
4. Each shard is `PUT` to its peer
5. The local `files` row records the shard layout (which peer holds which shard index)

On read:

1. Fetch any K of the M shards
2. Reconstruct ciphertext via Reed-Solomon decode
3. Decrypt client-side with the owner's key

## Drain on departure

A member cannot simply disappear — their hosted data would be lost. Departure is a two-step process:

1. **Mark draining:** member announces departure to the federation. New writes stop being placed on this peer.
2. **Re-replicate:** the federation transfers shards/copies hosted on the leaving peer to other members until the peer holds nothing federation-owned.
3. **Disconnect:** once drain completes, the member is removed from the federation roster.

Forced/unexpected departure (peer permanently offline) is handled by replication degradation alerts and a re-replication sweep. Content-sharing with N=3 tolerates one peer loss with no action; two peer losses trigger urgent re-replication.

## Security model

- **Peer identity:** Ed25519 keypair per Stohr instance. Federations track member pubkeys.
- **Federation identity:** Ed25519 keypair per federation. Used to sign invites and admin actions.
- **Transport:** all peer-to-peer traffic over HTTPS with mutual authentication via peer pubkey (signed request headers, similar to HTTP Signatures).
- **Content-sharing encryption:** group symmetric key (AES-256-GCM), delivered to each new member via X25519 sealed boxes from the introducer. Key rotation on member removal.
- **Space-offering encryption:** per-file symmetric key (AES-256-GCM), held only by the owner. Owner's key derived from their account credentials or a separately managed key (TBD — see Open questions).
- **No presigned URLs.** All access routes through the API. Clients never speak directly to peers' storage backends.

## Non-goals

- **Public/open federation.** No DHT, no anonymous peers, no reputation system. Federations are named and invite-gated.
- **Cryptocurrency or token incentives.** Federation membership is social/contractual, not economic.
- **Cross-federation interoperability.** A user can be a member of multiple federations, but the federations themselves are isolated namespaces.
- **Plaintext peer access in space-offering mode.** Hosts must not be able to read shards they hold. This is a hard property.
- **Client-side direct peer access.** All ops go through the API; the storage-driver contract that omits `signedUrl` extends to federation transport.

## Open questions

These need decisions before implementation begins:

- **Key custody in space-offering mode.** If the owner's key is derived from their password, password reset becomes data loss. Options: (a) escrow-encrypted recovery key in DB, (b) explicit warning that loss = loss, (c) shamir-share recovery across federation members.
- **Federation admin model.** Single owner? Multi-admin? Quorum for destructive actions?
- **Erasure coding library.** Pure-TS Reed-Solomon, or call out to a native lib via Bun FFI?
- **Discovery for member URLs.** If a peer changes its `base_url`, how do other members learn? Gossip on next handshake? Signed announcements?

## Implementation status

All six MVP phases shipped. See `src/federation/` and migrations `00000038`–`00000041`. The list below tracks what each phase landed.

### Phase 1 — Pairing & invites (foundation) ✅ Shipped

- DB schema: `federations`, `federation_members`, `federation_invites`
- Module: `src/federation/` with `index.ts`, `invites.ts`, `pairing.ts`, `keys.ts`
- Ed25519 keypair generation per instance and per federation (stored in DB, instance key in a new `instance_keys` row)
- Invite token mint + verify
- Pairing handshake endpoint (`POST /federation/pair`) — exchanges pubkeys, records membership
- UI: federation list, create federation, mint invite, accept invite
- **Ships:** users can form named federations and see each other's instances, but no file operations cross peers yet

### Phase 2 — Folder-as-mount-point + accounting ✅ Shipped

- Add `federation_id` and `federation_role` columns to `folders` (mount-point markers)
- Quota tracking columns on `federation_members`
- Migration + schema updates in both `migrations/` and `src/schema/index.ts`
- API: designate a folder as federation contribution, set quota cap, view federation status
- UI: federation folder badge, quota meter
- **Ships:** users can configure their contribution, but the folder is still local-only

### Phase 3 — Content-sharing federation ✅ Shipped

- Peer transport: signed HTTPS calls between instances (`src/federation/transport.ts`)
- Group key generation + distribution via X25519 sealed boxes on member join
- Placement algorithm: select N peers per file (`src/federation/placement.ts`)
- Receiver endpoints: `PUT /federation/blob/:id`, `GET /federation/blob/:id`, `DELETE /federation/blob/:id` (peer-authenticated)
- Upload handler in `src/files/` branches on `folders.federation_id` — if set and federation type is content-sharing, route through federation transport instead of local `STORAGE_DRIVER`
- **Ships:** content-sharing federations work end-to-end. This is the demoable milestone.

### Phase 4 — Space-offering federation ✅ Shipped (with caveats — see Open questions: erasure coding uses fragmented replication, not true Reed-Solomon, for the MVP)

- Client-side encryption in `src/web/` (Web Crypto API): per-file AES-256-GCM key, owner-held
- Reed-Solomon erasure coding (library decision — see Open questions)
- Shard placement (extends Phase 3 placement to M shards instead of N copies)
- Shard layout persistence in `files` row (new `federation_shards` JSON column or separate table)
- Reconstruction on read: fetch K shards, decode, decrypt
- **Ships:** zero-knowledge federation mode. Significantly harder than Phase 3.

### Phase 5 — Drain & departure ✅ Shipped (background sweep every 10 minutes; manual removal endpoint pending)

- `POST /federation/leave` — marks member as draining
- Background sweep: re-replicate shards/copies off the draining peer
- `DELETE /federation/members/:pubkey` — admin-initiated removal, triggers same drain flow
- Replication degradation detection + alert when peers go permanently offline
- **Ships:** federations are no longer one-way doors.

### Phase 6 — Polish ✅ Partially shipped (audit events + health endpoint + admin enable-toggle; per-federation rate limits + full admin UI pending)

- Federation audit log (`audit_events` extended)
- Per-federation rate limits (extend `rate_limits` table)
- Admin UI for federation health (peer status, replication factor per file, drain progress)
- Documentation: user-facing federation guide in `site/src/docs/`

### What is explicitly **not** in MVP scope

- Multi-admin federation governance
- Key rotation for content-sharing groups (Phase 5+ or later)
- Cross-federation file copy
- Federation merging or splitting
- Mobile-client direct federation participation (clients always go through their home instance's API)
