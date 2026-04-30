# Security model

This document describes how Stohr protects authentication, sessions, files, and shared links — and where you (the operator) are on the hook.

## Authentication

- **Passwords** hashed with Argon2id via `@atlas/auth`'s `hash` / `verify`. Plaintext passwords are never logged or stored. The login path runs an Argon2 verify against a fixed decoy hash on a missing-user lookup so response timing doesn't leak account existence.
- **JWTs** are signed with `SECRET`. In production the API refuses to start if `SECRET` is the default value or shorter than 32 characters. Tokens carry a `jti` claim, live for 7 days, and are server-side revocable via the `sessions` table.
- **Personal access tokens (PATs)** for SDKs / mobile apps are 32-byte random values prefixed `stohr_pat_`. Stored as SHA-256 hashes; revealed only at creation time.
- **WebAuthn passkeys** (FIDO2) — see below.
- **Password reset** via signed email link — see below.

## Session revocation

Every successful login/signup writes a row to `sessions` keyed by the JWT's `jti`. The auth guard checks this table on every authed request — revoking a session blocks the token immediately, even though it's still cryptographically valid.

Sessions are revoked automatically on:
- password change (all sessions other than current)
- password reset (all sessions, including current)
- MFA enable / disable (all sessions other than current)
- explicit user revocation via Settings → Security or `DELETE /me/sessions/:jti`

## Two-factor authentication (TOTP)

- RFC 6238 TOTP, HMAC-SHA1, 30-second window, ±1 window tolerance
- 160-bit symmetric secret per user, generated server-side, shown once via QR
- 10 backup codes minted at enable time (Argon2-hashed, single-use, regenerable)
- Login flow: password → `mfa_required: true` + 5-minute MFA challenge JWT → second call with code or backup code

## WebAuthn / passkeys

Built on `@simplewebauthn/server`. Users can register one or more passkeys at Settings → Security and use them as either a primary authenticator (passwordless login) or a second factor.

- **Registration**: `POST /me/passkeys/register/start` returns options; the client invokes `navigator.credentials.create()`; the response is verified at `POST /me/passkeys/register/finish`.
- **Discoverable login**: `POST /login/passkey/discover/start` issues a challenge; `navigator.credentials.get()` returns a credential the server verifies at `POST /login/passkey/discover/finish`. On success the user is logged in directly — no password needed.
- **Counter regression check**: every signed counter is compared to the stored last-seen counter. A regression aborts the verification (defends against credential cloning).
- **Challenges** live in `webauthn_challenges` with a 5-minute TTL and are swept periodically.
- The relying-party identifier is `RP_ID` from the environment. Passkeys created against `RP_ID=localhost` won't work after you flip `RP_ID` to your real domain — users have to re-register.

## Password reset

- Token format: `stohr_pwr_<base64url(32 bytes)>` — 256 bits of entropy.
- Stored as SHA-256 hash in `password_resets`. Plaintext only exists in the email link.
- 1-hour TTL; single-use (`used_at` timestamp set on apply).
- Rate-limited per email (5/hour) and per IP (30/hour) to prevent enumeration / floods.
- Apply path revokes all of the user's existing sessions.

The reset-link URL is built from `APP_URL`. In production this **must** be HTTPS — otherwise the token rides in plaintext over the wire.

## OAuth provider

- Authorization-code grant with **mandatory PKCE** (S256). Implicit grant is not supported.
- Authorization codes are 60-second TTL, single-use (atomic UPDATE … RETURNING claims them).
- `redirect_uri` is matched **exact-string only** against the registered list — no prefix or wildcard matching.
- Confidential-client secrets are SHA-256 hashed at rest and compared with `crypto.timingSafeEqual`.
- Refresh tokens rotate on every use; presenting a previously-revoked refresh token burns the entire chain (reuse-detection per RFC 6749 §10.4).
- Access tokens are short-lived JWTs (1h) carrying scope + client_id; refresh tokens are 30 days.
- Device flow polling is server-rate-limited per RFC 8628.

## Rate limiting

Sliding-bucket counters in the `rate_limits` table, keyed by IP and / or identity:

- `/login` — 5 per identity / 30 per IP per 15 min
- `/signup` — 10 per IP per hour
- `/login/mfa` — 6 per user / 30 per IP per 15 min
- `/password/forgot` — 5 per email / 30 per IP per hour
- `/password/reset` — 30 per IP per 15 min
- Share access, OAuth token, and admin endpoints all have their own buckets — see `src/security/ratelimit.ts` callers.

Limit hits return **429** with `{ error, retry_after }` (seconds).

The IP used for a bucket comes from `clientIp(req)`, which honors `X-Forwarded-For` / `X-Real-IP` **only** when the socket peer matches a configured `TRUSTED_PROXIES` CIDR. Otherwise the raw socket peer is used. This stops a remote attacker from spoofing IPs in headers to dodge limits or pin a victim's bucket.

## Audit log

`audit_events` records security-relevant actions: signups, logins (ok / fail / rate-limited / MFA), MFA enable/disable, password changes, password resets (request + apply), session revocations, OAuth grants and refreshes, OAuth refresh-token reuse detection. Owner-only view at Admin → Audit.

Stored fields: actor user, IP, user agent, structured metadata. Passwords, codes, tokens, and other secrets are **never** included in metadata — verify this when adding new audit calls.

## Security headers

The HTTP server wraps every response with:

- `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy: camera=(), microphone=(), geolocation=(), interest-cohort=()`
- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Resource-Policy: same-site`
- `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'` (production). Dev mode loosens `script-src` and `connect-src` so Bun's HMR works.

`'unsafe-inline'` is intentionally allowed for `style-src` only — the SPA uses inline `style=` attributes. Inline scripts are blocked, so an XSS payload can't exfiltrate the bearer token from `localStorage`.

## File serves: inline-MIME allowlist

`/files/:id/download?inline=1`, `/s/:token?inline=1`, and `/p/files/:id?inline=1` only render with the original `Content-Type` if the file's stored MIME is in a strict allowlist (`image/*`, `video/*`, `audio/*`, `application/pdf`, `text/plain`). Anything else — uploaded HTML, SVG, XML — is forced to `Content-Disposition: attachment` with `Content-Type: application/octet-stream`. SVG is explicitly excluded because it parses as XML and runs script.

This closes the stored-XSS path where an attacker uploads `evil.html` declared as `text/html` and lures a victim to open the inline link.

## Shared links

Public share creation requires an expiration (max 30 days). Optional password is Argon2-hashed; verified via the `X-Share-Password` request header at access time. The header is the **only** accepted password channel — query-string passwords (`?p=`) are rejected, since they end up in browser history, server access logs, and `Referer` headers.

Optional "burn after view by non-creator" atomically deletes the share row before serving — only one non-owner viewer wins.

A periodic sweep (guarded against overlap) deletes expired share rows hourly; lazy-delete also runs on access.

## Invite tokens

Invites are stored as SHA-256 hashes (migration 00000032). The plaintext appears only in the response to `POST /invites` (or `POST /admin/invite-requests/:id/invite`) and in the email Stohr sends to the recipient. List/admin views show metadata but never the token.

This means a Postgres dump or read-replica leak does not yield usable invite codes.

## Privilege checks

- Admin routes (anything under `/admin/*`) check `users.is_owner = true` **by querying the database on every request** rather than trusting the JWT claim. A demoted owner loses access immediately rather than at JWT expiry.
- Folder and file authorization (`src/permissions/index.ts`) walks the folder ancestry in a single recursive CTE and returns the nearest collaboration grant; folder grants cascade to descendants.

## Encryption at rest

**Stohr does not encrypt file bytes at the application layer.** Encryption-at-rest is the responsibility of the object store. Recommended setups:

| Provider | Encryption at rest |
| -------- | ------------------ |
| DigitalOcean Spaces | AES-256 by default for every object — nothing to configure |
| AWS S3 | Enable bucket default encryption (SSE-S3 / SSE-KMS) in the bucket settings |
| MinIO (self-hosted) | Set `MINIO_KMS_AUTO_ENCRYPTION=on` and configure a KMS key |
| RustFS / generic S3 | Confirm the provider's encryption-at-rest behavior; otherwise enable disk-level encryption (LUKS, FileVault, etc.) on the host |

JWT secrets, password hashes, TOTP secrets, PAT hashes, invite-token hashes, password-reset hashes, OAuth client-secret hashes, and refresh-token hashes all live in Postgres — encrypt the database volume at rest as well. DigitalOcean managed Postgres encrypts at rest by default; self-hosted Postgres should sit on an encrypted filesystem.

## Trusting reverse proxies

`TRUSTED_PROXIES` is a comma-separated list of IPv4 CIDRs that are allowed to set `X-Forwarded-For` / `X-Real-IP`. Behind a load balancer / Caddy / nginx, set this to the proxy's source range (e.g. `172.16.0.0/12` for the Docker bridge that compose creates). Leave it empty if the API receives traffic directly.

Setting it wrong has real consequences:

- Too narrow → the API records the proxy IP for every request, collapsing rate-limit buckets and audit logs onto a single IP. One bad actor locks out everyone.
- Too wide → an attacker can spoof XFF and either evade their own bucket or pin someone else's.

## Outbound webhooks

User-configured webhooks (`POST /me/webhooks`) deliver HMAC-SHA256 signed POSTs to subscriber URLs. Defence properties:

- Each webhook has a per-row `secret` (`whsec_…`, 32 random bytes). The plaintext is **only** returned at create + rotate; reads never expose it.
- Every delivery carries `x-stohr-signature: sha256=<hex>` HMAC over `${timestamp}.${body}` using the secret. Receivers should constant-time-compare and **reject anything more than ~5 minutes old** (replay defence — the timestamp is also signed, so it can't be moved without breaking the MAC).
- Each delivery has a unique `x-stohr-delivery` id; receivers should dedupe on it.
- Delivery is at-least-once: failed POSTs retry with exponential backoff (30s → 2m → 8m → 32m → 2h cap, max 6 attempts) and persist a `webhook_deliveries` row with the response status and a truncated body snippet.
- The HTTP fetch has a 10 s timeout with `AbortController`. We do **not** follow redirects beyond the first hop, and the `User-Agent` is fixed (`Stohr-Webhook/1.0`). We do not currently block private-network destinations — operators should put the API behind an egress firewall if SSRF risk is a concern.

## Upload memory ceiling

`MAX_UPLOAD_BYTES` (default 1 GiB) is the hard cap on a single request body. Bun buffers the body and `@atlas/storage` re-buffers it to compute the SigV4 payload hash, so this is effectively a per-upload memory ceiling. Plan for direct-to-S3 presigned PUTs in a future release to remove the ceiling.

## What still needs work

- **Application-layer encryption** for TOTP secrets and (eventually) file-level E2E
- **Bucket-default-encryption assertion** at API startup (probe the bucket and warn if the provider does not advertise encryption)
- **External pen test / bug bounty** — recommended before public launch
- **Direct-to-S3 presigned uploads** to remove the in-API buffering ceiling
- **SSRF protection on outbound webhooks** — block private/loopback/metadata IP ranges in delivery, not just at the firewall

## Reporting issues

Report security issues privately to [me@wess.io](mailto:me@wess.io). Please don't open a public GitHub issue for anything that could be exploited. We aim to acknowledge reports within 48 hours.
