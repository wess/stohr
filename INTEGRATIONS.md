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
| OAuth (Google, GitHub, Microsoft) sign-in | ✓ | ✓ | **missing** | P0 |
| SAML 2.0 / OIDC SSO | ✓ | ✓ | **missing** | P1 |
| TOTP / 2FA | ✓ | ✓ | **missing** | P0 |
| WebAuthn / passkeys | ✓ | ✓ | **missing** | P1 |
| SCIM user provisioning | ✓ | ✓ | **missing** | P2 |
| Session management (list / revoke devices) | ✓ | ✓ | **missing** | P1 |

Implementation notes: `@atlas/auth` already issues JWTs; adding OAuth/OIDC would slot into `src/auth/index.ts` alongside `signup`/`login`. 2FA needs a new column on `users` plus a verification step in the login flow.

## Clients

| Capability | Box | Dropbox | Stohr | Priority |
| --- | --- | --- | --- | --- |
| Web app | ✓ | ✓ | **have** | — |
| Desktop sync daemon (macOS/Windows/Linux) | ✓ | ✓ | **missing** | P0 |
| Mobile app (iOS/Android) | ✓ | ✓ | **missing** | P0 |
| WebDAV endpoint | ✓ (Box Drive) | ✗ | **missing** | P1 |
| CLI / scripting client | ✓ | ✓ | **missing** | P1 |
| Public HTTP API (documented) | ✓ | ✓ | **partial** (README lists routes; no OpenAPI spec) | P1 |

Implementation notes: sync is the single largest effort — protocol (delta/cursor-based), conflict resolution, file-watcher on the client. A WebDAV shim is the cheap middle ground and gets macOS Finder / Windows Explorer mounts for free. Publishing an OpenAPI spec unlocks SDK generation and is low-effort given the routes already exist.

## Developer platform

| Capability | Box | Dropbox | Stohr | Priority |
| --- | --- | --- | --- | --- |
| API tokens (user-scoped, revocable) | ✓ | ✓ | **missing** | P0 |
| OAuth apps / third-party access grants | ✓ | ✓ | **missing** | P1 |
| Outbound webhooks (file/folder events) | ✓ | ✓ | **missing** | P0 |
| Rate limiting | ✓ | ✓ | **missing** | P1 |
| OpenAPI / SDK | ✓ | ✓ | **missing** | P1 |

Implementation notes: current auth is JWT-only (7-day sessions). Long-lived API tokens need a new `api_tokens` table and middleware that accepts either `Bearer <jwt>` or `Bearer <api_token>`. Webhooks need an events table, a delivery worker (retry with backoff), and HMAC-signed payloads.

## File preview & editing

| Capability | Box | Dropbox | Stohr | Priority |
| --- | --- | --- | --- | --- |
| Image thumbnails | ✓ | ✓ | **have** (JPEG/PNG/WebP/GIF; server-generated WebP via `sharp`, served from `GET /files/:id/thumb`) | — |
| PDF preview | ✓ | ✓ | **missing** | P0 |
| Office document preview (docx/xlsx/pptx) | ✓ | ✓ | **missing** | P1 |
| Collaborative editing (Office/Google Docs) | ✓ (via Office Online) | ✓ (Dropbox Paper, Office) | **missing** | P2 |
| Video/audio streaming | ✓ | ✓ | **partial** (server streams, no transcoding) | P1 |
| Text/code viewer | ✓ | ✓ | **missing** | P1 |

Implementation notes: image thumbnails are now server-generated (sharp/libvips) and cached alongside the original in object storage. PDF preview still outstanding — pdf.js in the browser is the cheapest path; PDF-to-image on the server (via `pdftoppm` / `pdfium`) gives a richer grid thumbnail. Office editing integrates cleanly via OnlyOffice Document Server or Collabora Online — both speak WOPI.

## Sharing & collaboration

| Capability | Box | Dropbox | Stohr | Priority |
| --- | --- | --- | --- | --- |
| Public share links with expiry | ✓ | ✓ | **have** | — |
| Password-protected share links | ✓ | ✓ | **missing** | P0 |
| Download limits / view tracking | ✓ | ✓ | **missing** | P1 |
| File request (upload-only inbound links) | ✓ | ✓ | **missing** | P1 |
| Shared folders with collaborators | ✓ | ✓ | **missing** | P0 |
| Permission levels (view / comment / edit) | ✓ | ✓ | **missing** | P0 |
| Comments / annotations | ✓ | ✓ | **missing** | P2 |
| @-mentions and notifications | ✓ | ✓ | **missing** | P2 |

Implementation notes: multi-user sharing requires splitting ownership (`user_id`) from access (a `permissions` join table per folder/file). This is the single biggest schema change on the roadmap.

## Storage features

| Capability | Box | Dropbox | Stohr | Priority |
| --- | --- | --- | --- | --- |
| Version history | ✓ | ✓ | **have** | — |
| Soft-delete trash | ✓ | ✓ | **have** | — |
| Auto-purge trash after N days | ✓ | ✓ | **missing** | P1 |
| Per-user storage quotas | ✓ | ✓ | **missing** | P0 |
| Chunked / resumable uploads | ✓ | ✓ | **missing** | P0 |
| Deduplication (content-addressed storage) | ✓ | ✓ | **missing** | P2 |
| Server-side encryption at rest (KMS) | ✓ | ✓ | **partial** (depends on S3 backend config) | P1 |
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
| Zapier / Make / n8n | ✓ | ✓ | **missing** (needs webhooks + API tokens first) | P1 |
| Slack notifications | ✓ | ✓ | **missing** | P1 |
| Email notifications | ✓ | ✓ | **missing** | P0 |
| Email-to-upload | ✓ | ✓ | **missing** | P2 |
| E-signature (DocuSign / HelloSign) | ✓ | ✓ (HelloSign) | **missing** | P2 |
| IFTTT-style triggers | ✓ | ✓ | **missing** | P2 |

Implementation notes: Zapier/n8n/Make all work out of the box once the webhook + API-token infrastructure exists — no per-platform integration code required.

## Security & compliance

| Capability | Box | Dropbox | Stohr | Priority |
| --- | --- | --- | --- | --- |
| Antivirus scanning on upload | ✓ | ✓ | **missing** | P0 |
| Audit logs (who did what, when) | ✓ | ✓ | **missing** | P0 |
| Admin console (user mgmt, org settings) | ✓ | ✓ | **missing** | P1 |
| DLP (data loss prevention) rules | ✓ | ✓ | **missing** | P2 |
| Retention policies / legal hold | ✓ | ✓ | **missing** | P2 |
| Watermarking on previews | ✓ | ✗ | **missing** | P2 |
| IP allowlisting | ✓ | ✓ | **missing** | P2 |

Implementation notes: ClamAV via its TCP socket is the standard AV integration — run it as an async scan after upload and mark files quarantined until clean. Audit logs are a single append-only table plus a middleware that records the active user, route, and target IDs per request.

## Observability

| Capability | Box | Dropbox | Stohr | Priority |
| --- | --- | --- | --- | --- |
| Metrics (Prometheus) | — (internal) | — (internal) | **missing** | P1 |
| Structured logging | — | — | **partial** (console.log only) | P0 |
| Distributed tracing (OpenTelemetry) | — | — | **missing** | P2 |
| Health / readiness endpoints | — | — | **missing** | P0 |

---

## Suggested sequencing

If you want an opinionated order that unblocks the most downstream work per unit effort:

1. **API tokens + outbound webhooks** — unlocks Zapier/n8n/Slack without writing any per-platform code
2. **OAuth sign-in (Google/Microsoft/GitHub) + 2FA** — baseline security parity
3. **Email notifications (SMTP)** — needed for share notifications, password reset, account verification
4. **Chunked/resumable uploads + quotas** — stops big uploads from failing and prevents runaway storage
5. **Shared folders with permissions** — the single biggest schema change; everything collaborative depends on it
6. **AV scanning + audit logs** — required before anyone puts real data in this
7. **PDF preview** — image thumbnails already shipped; extending to PDFs is the next big preview win
8. **WebDAV endpoint** — cheap way to get Finder/Explorer mounts before writing a real sync client
9. **Desktop sync daemon + mobile app** — largest surface area; tackle last
