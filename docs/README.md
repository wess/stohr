# Stohr docs

In-depth guides for installing, deploying, and integrating with Stohr.

## Guides

- [**Architecture**](ARCHITECTURE.md) — what's in the box, how the pieces fit together, request lifecycle
- [**Configuration**](CONFIGURATION.md) — environment variables, the `payment_config` row, runtime settings
- [**Deploy**](DEPLOY.md) — turn-key Droplet deploy, App Platform alternative, manual setup
- [**REST API**](API.md) — every endpoint, grouped by resource
- [**S3-compatible endpoints**](S3.md) — using Stohr with `aws-cli`, `boto3`, or any AWS SDK
- [**SDKs**](SDKS.md) — TypeScript / Dart / Swift / Kotlin client libraries
- [**Admin panel**](ADMIN.md) — owner-only operations: invite requests, users, payments, stats
- [**Payments**](PAYMENTS.md) — Lemon Squeezy setup, tier pricing, webhooks

## Quick reference

- Source layout: `src/<feature>/index.ts` for each backend module, `src/web/` for the SPA, `scripts/deploy/` for the deploy automation
- Schema: `src/schema/index.ts` (TS) and `migrations/<n>_<name>/up.sql` (SQL)
- SDKs: [`sdks/`](../sdks/README.md)
