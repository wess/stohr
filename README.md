# Stohr

Self-hostable cloud storage with photo galleries, real-time collaboration, public sharing, an S3-compatible API, and built-in subscriptions. Bun + React + Postgres + S3-compatible blob store.

## Get started

```sh
cp .env.example .env
bun install
bun run dev
```

- API → http://localhost:3000
- Web → http://localhost:3001

The first visit lands on **Set up your Stohr** — the first signup becomes the owner with no invite token required. After that, signup is invite-only by default.

## Documentation

Everything lives in [`docs/`](docs/README.md):

- [Architecture](docs/ARCHITECTURE.md) — how the pieces fit together
- [Configuration](docs/CONFIGURATION.md) — env vars, runtime settings
- [Deploy](docs/DEPLOY.md) — DigitalOcean droplet (turn-key), App Platform, manual
- [REST API](docs/API.md) — every endpoint, grouped by resource
- [S3-compatible API](docs/S3.md) — using `aws-cli`, `boto3`, or any AWS SDK with stohr
- [SDKs](docs/SDKS.md) — official client libraries (TS / Dart / Swift / Kotlin) in [`sdks/`](sdks/README.md)
- [Admin panel](docs/ADMIN.md) — owner-only operations
- [Payments](docs/PAYMENTS.md) — Lemon Squeezy setup, tiers, webhooks

## License

MIT — see [LICENSE](LICENSE).
