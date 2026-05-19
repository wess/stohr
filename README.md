# Stohr

Self-hostable cloud storage. Photo galleries, multi-user collaboration, public sharing, an S3-compatible API, OAuth for third-party apps, MFA + WebAuthn passkeys, password reset, session management — plus a **federation layer** for pooling storage with peers and a **WebDAV endpoint** for mounting your account from any OS.

Bun + React + Postgres + S3-compatible blob store.

## Features

- **Files & folders** — versioned uploads, soft-delete + trash, image thumbnails, photo-gallery folders.
- **Sharing** — link-based shares with expiry, password gate, burn-on-view; public folders served at `/p/:user/:folder`.
- **Collaboration** — folder/file collaborators with viewer/editor roles; cascade through subfolders.
- **Federation** — invite-gated peer networks. Pool storage with friends in **content-sharing** mode (group-encrypted, browseable) or **space-offering** mode (end-to-end encrypted, zero-knowledge hosting). Ed25519-signed peer transport, replication or erasure coding, drain-on-departure. See [`docs/FEDERATION.md`](docs/FEDERATION.md).
- **WebDAV** — RFC 4918 endpoint at `/webdav`. Mount your account from macOS Finder, Windows Explorer, GNOME Files, or `rclone`. Per-user HTTP-Basic credentials, separate from the account password. See [`docs/WEBDAV.md`](docs/WEBDAV.md).
- **Auth** — email + password, TOTP 2FA, WebAuthn passkeys, password reset, full session list with per-device revoke.
- **OAuth provider** — third-party apps integrate via authorization-code with PKCE, refresh-token rotation, device flow.
- **S3-compatible API** — point any S3 SDK or `s3cmd`/`rclone` at Stohr; reuses your account quota.
- **Storage quotas** — optional per-user storage caps the owner sets from the admin panel.
- **Admin** — invite issuance, audit log, user/owner management, OAuth client registry, per-user storage caps, **owner-toggleable feature flags** (federation, WebDAV) — no restart needed.

## Quick start

```sh
cp .env.example .env
bun install
bun run dev
```

- API → http://localhost:3000
- Web → http://localhost:3001

The first signup becomes the owner. After that, signup is invite-only.

> **Email is required for production.** Invites, password reset, and collaboration invites all send mail. Set `RESEND_API_KEY` in your `.env` before going live (leave it blank in dev — emails print to the console). See [Configuration](docs/CONFIGURATION.md).

## Going further

Full docs live in [`docs/`](docs/README.md) — architecture, every endpoint, deploy recipes, the S3-compatible API, SDKs, OAuth, admin panel.

- [Configuration reference](docs/CONFIGURATION.md) — every env var
- [Deploy guide](docs/DEPLOY.md) — DigitalOcean, App Platform, manual Docker
- [API reference](docs/API.md) — complete endpoint surface
- [Federation](docs/FEDERATION.md) — encrypted peer networks for pooled storage
- [WebDAV](docs/WEBDAV.md) — mount Stohr as a network drive
- [Security model](SECURITY.md)
- [Integrations roadmap](INTEGRATIONS.md)
- [SDKs](sdks/README.md) — TypeScript, Dart, Swift, Kotlin

## License

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
