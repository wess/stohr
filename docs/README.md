# Stohr docs

In-depth guides for installing, deploying, and integrating with Stohr.

## Guides

- [**Architecture**](ARCHITECTURE.md) — what's in the box, how the pieces fit together, request lifecycle
- [**Configuration**](CONFIGURATION.md) — environment variables, the `payment_config` row, runtime settings
- [**Deploy**](DEPLOY.md) — turn-key Droplet deploy, App Platform alternative, manual setup
- [**REST API**](API.md) — every endpoint, grouped by resource
- [**OAuth 2.0**](OAUTH.md) — Authorization Code + PKCE and Device Authorization Grant for third-party apps
- [**Action folders**](ACTIONS.md) — folders that run actions on file/folder events; how to write a built-in
- [**S3-compatible endpoints**](S3.md) — using Stohr with `aws-cli`, `boto3`, or any AWS SDK
- [**SDKs**](SDKS.md) — TypeScript / Dart / Swift / Kotlin client libraries
- [**Admin panel**](ADMIN.md) — owner-only operations: invite requests, users, payments, audit, OAuth clients
- [**Payments**](PAYMENTS.md) — Lemon Squeezy setup, tier pricing, webhooks

Cross-cutting:

- [Security model](../SECURITY.md) — auth, sessions, MFA, rate limits, audit, share security, encryption-at-rest
- [Integrations roadmap](../INTEGRATIONS.md) — feature parity status vs. Box / Dropbox

## Quick reference

- Source layout: `src/<feature>/index.ts` for each backend module, `src/web/` for the SPA, `scripts/deploy/` for the deploy automation
- Schema: `src/schema/index.ts` (TS) and `migrations/<n>_<name>/up.sql` (SQL — authoritative at runtime)
- SDKs: [`sdks/`](../sdks/README.md)
- Native apps: [`apps/desktop`](../apps/desktop/README.md) (Stohrshot menu-bar), [`apps/mobile`](../apps/mobile/README.md) (Flutter)
