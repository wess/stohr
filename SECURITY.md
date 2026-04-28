# Security model

This document describes how Stohr protects authentication, sessions, files, and shared links — and where you (the operator) are on the hook.

## Authentication

- **Passwords** are hashed with bcrypt via `@atlas/auth`'s `hash` / `verify`. Plaintext passwords are never logged or stored.
- **JWTs** are signed with `SECRET` (must be set in `.env`; do not ship the default). Tokens carry a `jti` claim and live for 7 days, but are server-side revocable via the `sessions` table.
- **Personal access tokens (PATs)** for SDKs / mobile apps are random 32-byte values prefixed `stohr_pat_`. Stored as SHA-256 hashes; revealed only at creation time.

## Session revocation

Every successful login/signup writes a row to `sessions` keyed by the JWT's `jti`. The auth guard checks this table on every authed request — revoking a session blocks the token immediately, even though it's still cryptographically valid.

Sessions are revoked automatically on:
- password change (all sessions other than current)
- MFA enable / disable (all sessions other than current)
- explicit user revocation via Settings → Security or `DELETE /me/sessions/:jti`

## Two-factor authentication (TOTP)

- RFC 6238 TOTP, HMAC-SHA1, 30-second window, ±1 window tolerance
- 160-bit symmetric secret per user, generated server-side, shown once via QR
- 10 backup codes minted at enable time (bcrypt-hashed, single-use, regenerable)
- Login flow: password → `mfa_required: true` + 5-minute MFA challenge JWT → second call with code or backup code

## Rate limiting

Sliding-bucket counters in the `rate_limits` table. Limits per 15 minutes:
- `/login` — 5 per identity, 30 per IP
- `/signup` — 10 per IP per hour
- `/login/mfa` — 6 per user, 30 per IP

Limit hits return `429` with a `retry_after` body field.

## Audit log

`audit_events` records security-relevant actions: signups, logins (ok / fail / rate-limited / MFA), MFA enable/disable, password changes, session revocations. Owner-only view at Settings → Admin → Audit.

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

## Shared links

Public share creation requires an expiration (max 30 days). Optional password is bcrypt-hashed; verified via `X-Share-Password` header at access time. Optional "burn after view by non-creator" atomically deletes the share row before serving — only one non-owner viewer wins.

A periodic `setInterval` deletes expired share rows hourly; lazy-delete also runs on access.

## Encryption at rest

**Stohr does not encrypt file bytes at the application layer.** Encryption-at-rest is the responsibility of the object store. Recommended setups:

| Provider | Encryption at rest |
| -------- | ------------------ |
| DigitalOcean Spaces | AES-256 by default for every object — nothing to configure |
| AWS S3 | Enable bucket default encryption (SSE-S3 / SSE-KMS) in the bucket settings |
| MinIO (self-hosted) | Set `MINIO_KMS_AUTO_ENCRYPTION=on` and configure a KMS key |
| RustFS / generic S3 | Confirm the provider's encryption-at-rest behavior; otherwise enable disk-level encryption (LUKS, FileVault, etc.) on the host |

JWT secrets, password hashes, TOTP secrets, and PAT hashes live in Postgres — encrypt the database volume at rest as well. DigitalOcean managed Postgres encrypts at rest by default; self-hosted Postgres should sit on an encrypted filesystem.

A future change will encrypt TOTP secrets at the application layer using a key derived from `SECRET`, so DB-level access alone won't expose them.

## What still needs work

- **Application-layer encryption** for TOTP secrets and (eventually) file-level E2E
- **WebAuthn / passkey** support for stronger second factor
- **Bucket-default-encryption assertion** at API startup (probe the bucket and warn if the provider does not advertise encryption)
- **External pen test / bug bounty** — recommended before public launch

## Reporting issues

Report security issues privately to [me@wess.io](mailto:me@wess.io). Please don't open a public GitHub issue for anything that could be exploited. We aim to acknowledge reports within 48 hours.
