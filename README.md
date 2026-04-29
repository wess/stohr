# Stohr

Self-hostable cloud storage. Photo galleries, multi-user collaboration, public sharing, an S3-compatible API, OAuth for third-party apps, MFA + session management, and built-in subscriptions.

Bun + React + Postgres + S3-compatible blob store.

## Quick start

```sh
cp .env.example .env
bun install
bun run dev
```

- API → http://localhost:3000
- Web → http://localhost:3001

The first signup becomes the owner. After that, signup is invite-only.

## Going further

Full docs live in [`docs/`](docs/README.md) — architecture, every endpoint, deploy recipes, the S3-compatible API, SDKs, OAuth, payments, admin panel.

- [Security model](SECURITY.md)
- [Integrations roadmap](INTEGRATIONS.md)
- [SDKs](sdks/README.md) — TypeScript, Dart, Swift, Kotlin

## License

MIT — see [LICENSE](LICENSE).
