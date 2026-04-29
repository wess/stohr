# Stohr

Self-hostable cloud storage. Photo galleries, multi-user collaboration, public sharing, an S3-compatible API, OAuth for third-party apps, MFA + WebAuthn passkeys, password reset, session management, and built-in subscriptions.

Bun + React + Postgres + S3-compatible blob store.

## Features

- **Files & folders** — versioned uploads, soft-delete + trash, image thumbnails, photo-gallery folders.
- **Sharing** — link-based shares with expiry, password gate, burn-on-view; public folders served at `/p/:user/:folder`.
- **Collaboration** — folder/file collaborators with viewer/editor roles; cascade through subfolders.
- **Auth** — email + password, TOTP 2FA, WebAuthn passkeys, password reset, full session list with per-device revoke.
- **OAuth provider** — third-party apps integrate via authorization-code with PKCE, refresh-token rotation, device flow.
- **S3-compatible API** — point any S3 SDK or `s3cmd`/`rclone` at Stohr; reuses your account quota.
- **Subscriptions** — built-in Lemon Squeezy integration with tier quotas and admin override.
- **Admin** — invite issuance, audit log, user/owner management, OAuth client registry, payment configuration.

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

Full docs live in [`docs/`](docs/README.md) — architecture, every endpoint, deploy recipes, the S3-compatible API, SDKs, OAuth, payments, admin panel.

- [Configuration reference](docs/CONFIGURATION.md) — every env var
- [Deploy guide](docs/DEPLOY.md) — DigitalOcean, App Platform, manual Docker
- [API reference](docs/API.md) — complete endpoint surface
- [Security model](SECURITY.md)
- [Integrations roadmap](INTEGRATIONS.md)
- [SDKs](sdks/README.md) — TypeScript, Dart, Swift, Kotlin

## License

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
