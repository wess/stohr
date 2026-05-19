# Stohr SDKs

Official client libraries for the [Stohr](https://stohr.io) cloud-storage API.

| Language     | Path             | Targets                                    | Status |
|--------------|------------------|--------------------------------------------|:------:|
| TypeScript   | `typescript/`    | Bun, Deno, Node 20+, browsers              | ✓      |
| Dart         | `dart/`          | Flutter, Dart 3+                           | ✓      |
| Swift        | `swift/`         | iOS 15+, macOS 12+, tvOS 15+, watchOS 8+   | ✓      |
| Kotlin       | `kotlin/`        | Android (API 24+), JVM 17+                 | ✓      |

All four wrap the same REST API (`https://stohr.io/api`) and expose operations
named idiomatically per language.

> Note: WebAuthn / passkey endpoints and the password-reset flow are
> currently REST-only across all four SDKs. Until they land, call
> `/me/passkeys/*`, `/login/passkey/*`, and `/password/*` directly with the
> SDK's HTTP client.

## Operation coverage

The TypeScript SDK currently has the most complete surface. Dart, Swift, and
Kotlin cover the "happy path" (auth, folders, files, shares, S3 keys) — see
the full matrix in [`docs/SDKS.md`](../docs/SDKS.md#operation-coverage) and the
gaps marked `—` there.

Core surface that every SDK has:

```
auth         login, signup
me           get, usage
folders      list, create, delete
files        list, upload, download, delete
shares       create(fileId, expiresInSeconds)
s3Keys       list, create, revoke
```

Beyond that, capability is uneven and tracked per-language in `docs/SDKS.md`.
When adding a new endpoint to the backend, mirror it across all four SDKs in
the same PR (or note the gap in the matrix).

## Auth

Every SDK returns a token from `login` / `signup` and caches it on the
client instance. Subsequent calls send `Authorization: Bearer <token>`.
Restore from your own storage with `setToken(t)` (TS / Kotlin / Swift) or
`client.token = t` (Dart).

## Errors

Each SDK throws / propagates a typed `StohrError` carrying the HTTP `status`
and the parsed JSON body (when one was returned). Branch on it for quota,
auth, and validation handling — see [`docs/SDKS.md#errors`](../docs/SDKS.md#errors).

## S3-compatible alternative

If you'd rather use existing S3 tooling (`aws-cli`, `boto3`, `aws-sdk`),
Stohr exposes a SigV4-authenticated S3 endpoint at
`https://stohr.io/s3/<bucket>/<key>` where `bucket` is your username and
`key` is a slash-separated file path inside your storage. Mint S3 access
keys via `POST /api/me/s3-keys` (or your SDK's `s3Keys.create(...)`) and
configure your S3 client to use them. See [`docs/S3.md`](../docs/S3.md) for
full details.

## Versioning

All SDKs target API version `v1`. Breaking changes will bump the SDK
major version. Patch releases match across languages where possible.

## Contributing

Each SDK has its own `README.md` with build/test instructions. All four
ship from this monorepo so that adding a new endpoint to the stohr server
prompts a parallel add across all client libraries. The full reference
(parallel code samples, operation matrix, custom-HTTP recipes) is in
[`docs/SDKS.md`](../docs/SDKS.md).
