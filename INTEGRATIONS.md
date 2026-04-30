# Integrations

Gap analysis of Stohr's integration surface against Box.com and Dropbox, grouped by capability and tiered by priority.

- **P0** — foundational; Stohr is hard to adopt without it
- **P1** — important for parity; expected by most users
- **P2** — nice-to-have; long-tail parity

Status legend: **have** · **partial** · **missing**

---

## Auth & identity

| Capability | Box | Dropbox | Stohr | Priority |
| --- | --- | --- | --- | --- |
| Email + password | ✓ | ✓ | **have** | — |
| Password reset (forgot-password email link) | ✓ | ✓ | **have** (signed `stohr_pwr_*` token, 1-hour TTL, single-use, rate-limited per email + IP, revokes all sessions on apply) | — |
| Sign in *with* Google / GitHub / Microsoft (Stohr as OAuth client) | ✓ | ✓ | **missing** | P0 |
| SAML 2.0 / OIDC SSO | ✓ | ✓ | **missing** | P1 |
| TOTP / 2FA | ✓ | ✓ | **have** (RFC 6238 TOTP, ±1 window, 10 single-use backup codes, MFA challenge JWT during login) | — |
| WebAuthn / passkeys | ✓ | ✓ | **have** (registration + discoverable login via `@simplewebauthn/server`; counter-regression check; challenges TTL'd in `webauthn_challenges`) | — |
| SCIM user provisioning | ✓ | ✓ | **missing** | P2 |
| Session management (list / revoke devices) | ✓ | ✓ | **have** (`sessions` table, JWT `jti` checked per request, list/revoke/revoke-others endpoints) | — |

Note: Stohr is an OAuth **provider** (third-party apps integrate against it) — that ships, see [docs/OAUTH.md](docs/OAUTH.md). The "OAuth sign-in" row above is the inverse: letting Stohr accept Google/GitHub/Microsoft as identity providers. That's still missing.

Implementation notes: `@atlas/auth` already issues JWTs and the session table makes them server-side revocable. WebAuthn and password reset shipped in migrations 00000029 / 00000030. OAuth/OIDC consumer sign-in (login *with* Google/GitHub) would slot in alongside `signup`/`login` in `src/auth/`.

## Clients

| Capability | Box | Dropbox | Stohr | Priority |
| --- | --- | --- | --- | --- |
| Web app | ✓ | ✓ | **have** | — |
| Desktop sync daemon (macOS/Windows/Linux) | ✓ | ✓ | **partial** (Stohrshot menu-bar screenshot client in `apps/desktop`; no general sync yet) | P0 |
| Mobile app (iOS/Android) | ✓ | ✓ | **partial** (Flutter app scaffolded in `apps/mobile`) | P0 |
| WebDAV endpoint | ✓ (Box Drive) | ✗ | **missing** | P1 |
| CLI / scripting client | ✓ | ✓ | **partial** (S3-compatible API + AWS CLI works) | P1 |
| Public HTTP API (documented) | ✓ | ✓ | **have** (full reference in [`docs/API.md`](docs/API.md); no OpenAPI spec yet) | — |

Implementation notes: general sync is the single largest effort — protocol (delta/cursor-based), conflict resolution, file-watcher on the client. A WebDAV shim is the cheap middle ground and gets macOS Finder / Windows Explorer mounts for free. Publishing an OpenAPI spec unlocks SDK generation and is low-effort given the routes already exist.

## Developer platform

| Capability | Box | Dropbox | Stohr | Priority |
| --- | --- | --- | --- | --- |
| API tokens (user-scoped, revocable) | ✓ | ✓ | **have** (PATs prefixed `stohr_pat_`, SHA-256 hashed, mintable via `POST /me/apps`) | — |
| OAuth apps / third-party access grants | ✓ | ✓ | **have** (full OAuth 2.0 provider: auth code + PKCE, device flow, refresh token rotation; see [OAUTH.md](docs/OAUTH.md)) | — |
| Outbound webhooks (file/folder events) | ✓ | ✓ | **have** (per-user HMAC-SHA256 signed; retries via durable job runner with exponential backoff; delivery log + replay; see `POST /me/webhooks` in [API.md](docs/API.md#webhooks-auth-required-first-party-only)) | — |
| Rate limiting | ✓ | ✓ | **have** (sliding-bucket counters in `rate_limits`; per-IP / per-identity / per-user on auth + MFA) | — |
| Native SDKs | ✓ | ✓ | **have** (TypeScript / Dart / Swift / Kotlin under [`sdks/`](sdks/README.md)) | — |
| OpenAPI spec | ✓ | ✓ | **missing** | P1 |

Implementation notes: with outbound webhooks shipped, Zapier/Make/n8n integrations are now wireable without per-platform code (PATs and OAuth were already done). The remaining developer-platform gap is publishing an OpenAPI spec to unlock SDK regeneration.

## File preview & editing

| Capability | Box | Dropbox | Stohr | Priority |
| --- | --- | --- | --- | --- |
| Image thumbnails | ✓ | ✓ | **have** (JPEG/PNG/WebP/GIF; server-generated WebP via `sharp`, served from `GET /files/:id/thumb`) | — |
| PDF preview | ✓ | ✓ | **have** (browser-native viewer in the SPA preview modal — `<iframe src=blob:…>` with `sandbox` attrs and "open in new tab" fallback; CSP allows `frame-src blob:`) | — |
| Office document preview (docx/xlsx/pptx) | ✓ | ✓ | **missing** | P1 |
| Collaborative editing (Office/Google Docs) | ✓ (via Office Online) | ✓ (Dropbox Paper, Office) | **missing** | P2 |
| Video/audio streaming | ✓ | ✓ | **partial** (server streams, no transcoding) | P1 |
| Text/code viewer | ✓ | ✓ | **missing** | P1 |

Implementation notes: pdf.js in the browser is the cheapest path for PDF preview; PDF-to-image on the server (via `pdftoppm` / `pdfium`) gives a richer grid thumbnail. Office editing integrates cleanly via OnlyOffice Document Server or Collabora Online — both speak WOPI.

## Sharing & collaboration

| Capability | Box | Dropbox | Stohr | Priority |
| --- | --- | --- | --- | --- |
| Public share links with expiry | ✓ | ✓ | **have** (max 30 days; per-share expiry required) | — |
| Password-protected share links | ✓ | ✓ | **have** (Argon2-hashed, verified via `X-Share-Password` header only — query-string fallback removed) | — |
| Burn-after-view share links | ✓ (some plans) | ✗ | **have** (atomic delete-before-serve; only one non-owner viewer wins) | — |
| Download limits / view tracking | ✓ | ✓ | **missing** | P1 |
| File request (upload-only inbound links) | ✓ | ✓ | **missing** | P1 |
| Shared folders with collaborators | ✓ | ✓ | **have** (folder + file collaborators table; viewer/editor roles; folder grants cascade to children) | — |
| Permission levels (view / comment / edit) | ✓ | ✓ | **partial** (viewer/editor; no comment role) | P1 |
| Comments / annotations | ✓ | ✓ | **missing** | P2 |
| @-mentions and notifications | ✓ | ✓ | **missing** | P2 |

## Storage features

| Capability | Box | Dropbox | Stohr | Priority |
| --- | --- | --- | --- | --- |
| Version history | ✓ | ✓ | **have** | — |
| Soft-delete trash | ✓ | ✓ | **have** | — |
| Auto-purge trash after N days | ✓ | ✓ | **have** (recurring `trash.autopurge` job; `TRASH_RETENTION_DAYS` env, default 30) | — |
| Per-user storage quotas | ✓ | ✓ | **have** (per-tier `storage_quota_bytes`; enforced at upload; over-quota → `402` with structured body) | — |
| Chunked / resumable uploads | ✓ | ✓ | **missing** | P0 |
| Deduplication (content-addressed storage) | ✓ | ✓ | **missing** | P2 |
| Server-side encryption at rest (KMS) | ✓ | ✓ | **partial** (depends on S3 backend config — see [SECURITY.md](SECURITY.md)) | P1 |
| E2E encrypted vault | ✓ (Box Shield) | ✗ | **missing** | P2 |

Implementation notes: current upload path buffers the whole file in memory via `parseMultipart`. Resumable uploads need a tus or S3-multipart-style protocol — mandatory once anyone tries to upload a video over flaky Wi-Fi.

## Search

| Capability | Box | Dropbox | Stohr | Priority |
| --- | --- | --- | --- | --- |
| Filename search | ✓ | ✓ | **have** (Postgres `pg_trgm` trigram indexes + `type:`/`ext:` filter tokens; cmd+k palette UI) | — |
| Full-text search (file contents) | ✓ | ✓ | **missing** | P1 |
| OCR for images / PDFs | ✓ | ✓ | **missing** | P2 |
| Metadata / tag search | ✓ | ✓ | **missing** | P2 |

Implementation notes: Postgres `tsvector` gives decent FTS without a new dependency; add an async worker that extracts text on upload (`pdftotext`, `tika`, etc.).

## Automation & third-party

| Capability | Box | Dropbox | Stohr | Priority |
| --- | --- | --- | --- | --- |
| Zapier / Make / n8n | ✓ | ✓ | **partial** (HMAC-signed outbound webhooks shipped; no per-platform pre-built integrations yet) | P1 |
| Slack notifications | ✓ | ✓ | **missing** | P1 |
| Transactional email (invites, password reset, collab invites) | ✓ | ✓ | **have** (Resend integration; falls back to console output when `RESEND_API_KEY` is empty) | — |
| Activity-event email notifications (file shared, comment added, etc.) | ✓ | ✓ | **missing** | P1 |
| Email-to-upload | ✓ | ✓ | **missing** | P2 |
| E-signature (DocuSign / HelloSign) | ✓ | ✓ (HelloSign) | **missing** | P2 |
| IFTTT-style triggers | ✓ | ✓ | **missing** | P2 |

Implementation notes: PATs, OAuth, and outbound webhooks all ship — Zapier/n8n/Make work today using the standard "webhook trigger + HTTP action" path on each platform. The remaining work is publishing pre-built app templates on each marketplace.

## Security & compliance

| Capability | Box | Dropbox | Stohr | Priority |
| --- | --- | --- | --- | --- |
| Antivirus scanning on upload | ✓ | ✓ | **missing** | P0 |
| Audit logs (who did what, when) | ✓ | ✓ | **have** (`audit_events` table + Admin → Audit panel; auth, MFA, sessions, password reset, OAuth grants + reuse-detection) | — |
| Hashed-at-rest invites and reset tokens | ✓ | ✓ | **have** (SHA-256 only; plaintext returned once at creation) | — |
| Inline file XSS protection | — | — | **have** (MIME allowlist for `?inline=1`; SVG, HTML, XML force download as `application/octet-stream`) | — |
| Trusted-proxy IP handling | — | — | **have** (`TRUSTED_PROXIES` env; XFF only honored from configured CIDRs) | — |
| Admin console (user mgmt, org settings) | ✓ | ✓ | **have** (Admin panel: users, invites, payments, audit, OAuth clients, stats) | — |
| Security headers (HSTS, COOP/CORP, etc.) | ✓ | ✓ | **have** (set on every response by `withSecurityHeaders`) | — |
| DLP (data loss prevention) rules | ✓ | ✓ | **missing** | P2 |
| Retention policies / legal hold | ✓ | ✓ | **missing** | P2 |
| Watermarking on previews | ✓ | ✗ | **missing** | P2 |
| IP allowlisting | ✓ | ✓ | **missing** | P2 |

Implementation notes: ClamAV via its TCP socket is the standard AV integration — run it as an async scan after upload and mark files quarantined until clean.

## Observability

| Capability | Box | Dropbox | Stohr | Priority |
| --- | --- | --- | --- | --- |
| Metrics (Prometheus) | — (internal) | — (internal) | **missing** | P1 |
| Structured logging | — | — | **have** (JSON-line logger in `src/log/`; `LOG_LEVEL` env; one access-log line per request with `request_id`, method, path, status, duration_ms) | — |
| Distributed tracing (OpenTelemetry) | — | — | **missing** | P2 |
| Health / readiness endpoints | — | — | **have** (`GET /healthz` liveness, `GET /readyz` checks DB + storage and returns 503 on failure) | — |

---

## Suggested sequencing

If you want an opinionated order that unblocks the most downstream work per unit effort:

1. **Chunked / resumable uploads** — `MAX_UPLOAD_BYTES` is currently a memory ceiling, not a disk ceiling, because `@atlas/storage` buffers the body to compute SigV4. Presigned-PUT direct-to-S3 removes the buffering and unblocks large uploads on flaky networks
2. **OAuth sign-in** (Google/Microsoft/GitHub) — login parity with Box/Dropbox; MFA + sessions + WebAuthn are already in place
3. **AV scanning** — required before anyone puts real data in this; audit logs and the durable job runner are already in place to record findings and run scans asynchronously
4. **Activity-event email notifications** — transactional email already ships; activity-driven notifications build on the same Resend integration. The webhook event stream + job runner make this a small wiring task
5. **OpenAPI spec** — auto-generate from the existing `@atlas/server` routes, then regenerate the four SDKs from it. Turns SDK maintenance from a four-repo chore into a CI step
6. **WebDAV endpoint** — cheap way to get Finder/Explorer mounts before writing a full sync client
7. **Desktop sync daemon + mobile app** — Stohrshot and the Flutter app exist; turning either into a full sync client is the largest remaining surface area
8. **Prometheus metrics + OpenTelemetry tracing** — structured logs and `/readyz` shipped. Metrics + traces are the next observability layer
