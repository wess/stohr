# SDKs

Four official client libraries live in [`sdks/`](../sdks/README.md). They all wrap the same v1 REST surface (`https://stohr.io/api`) in idiomatic per-language shapes.

| Language   | Path                                         | Targets                                    | Status |
| ---------- | -------------------------------------------- | ------------------------------------------ | :----: |
| TypeScript | [`sdks/typescript`](../sdks/typescript/)     | Bun, Deno, Node 20+, modern browsers       |   ✓    |
| Dart       | [`sdks/dart`](../sdks/dart/)                 | Dart 3+, Flutter                           |   ✓    |
| Swift      | [`sdks/swift`](../sdks/swift/)               | iOS 15+, macOS 12+, tvOS 15+, watchOS 8+   |   ✓    |
| Kotlin     | [`sdks/kotlin`](../sdks/kotlin/)             | Android (API 24+), JVM 17+                 |   ✓    |

> WebAuthn / passkey endpoints and the password-reset flow are REST-only — call `/me/passkeys/*`, `/login/passkey/*`, and `/password/*` directly with the SDK's HTTP client. They'll be added to all four SDKs in a follow-up.

## Install

```sh
# TypeScript (Bun, Node, Deno)
bun add @stohr/sdk

# Dart / Flutter
dart pub add stohr   # or add `stohr: ^0.1.0` to pubspec.yaml

# Swift Package Manager — in Package.swift:
.package(url: "https://github.com/wess/stohr.git", from: "0.1.0")

# Kotlin (Gradle)
implementation("io.stohr:stohr-sdk:0.1.0")
implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.7.3")
```

## Operation coverage

The four SDKs share the same v1 surface but currently land at different coverage levels. Use this table to know what's wrapped and what to call via raw HTTP.

| Group           | Operation                          | TS  | Dart | Swift | Kotlin |
| --------------- | ---------------------------------- | :-: | :--: | :---: | :----: |
| `auth`          | `login(identity, password)`        | ✓   | ✓    | ✓     | ✓      |
| `auth`          | `loginMfa(token, code/backup)`     | —   | ✓    | —     | —      |
| `auth`          | `signup({...inviteToken})`         | ✓   | ✓    | ✓     | ✓      |
| `me`            | `get()`                            | ✓   | ✓    | ✓     | ✓      |
| `me`            | `update(patch)`                    | ✓   | —    | —     | —      |
| `me`            | `usage()`                          | ✓   | ✓    | ✓     | ✓      |
| `me`            | `changePassword(current, next)`    | ✓   | —    | —     | —      |
| `folders`       | `list(parentId?)`                  | ✓   | ✓    | ✓     | ✓      |
| `folders`       | `get(id)`                          | ✓   | —    | —     | —      |
| `folders`       | `create(name, parentId?, opts?)`   | ✓   | ✓    | ✓     | ✓      |
| `folders`       | `rename(id, name)`                 | ✓   | ✓    | —     | —      |
| `folders`       | `move(id, parentId?)`              | ✓   | —    | —     | —      |
| `folders`       | `delete(id)`                       | ✓   | ✓    | ✓     | ✓      |
| `files`         | `list(folderId?, q?)`              | ✓   | ✓    | ✓     | ✓      |
| `files`         | `get(id)`                          | ✓   | ✓    | —     | —      |
| `files`         | `upload({blob, name, folderId?})`  | ✓   | ✓    | ✓     | ✓      |
| `files`         | `download(id)`                     | ✓   | ✓    | ✓     | ✓      |
| `files`         | `thumbnail(id)`                    | ✓   | —    | —     | —      |
| `files`         | `rename(id, name)`                 | ✓   | ✓    | —     | —      |
| `files`         | `move(id, folderId?)`              | ✓   | ✓    | —     | —      |
| `files`         | `delete(id)`                       | ✓   | ✓    | ✓     | ✓      |
| `files`         | `versions(id)`                     | ✓   | —    | —     | —      |
| `shares`        | `list()`                           | ✓   | —    | —     | —      |
| `shares`        | `create(fileId, expiresInSeconds)` | ✓   | ✓    | ✓     | ✓      |
| `shares`        | `delete(id)`                       | ✓   | ✓    | —     | —      |
| `collaborators` | `list(kind, id)`                   | ✓   | —    | —     | —      |
| `collaborators` | `add(kind, id, identity, role)`    | ✓   | ✓    | —     | —      |
| `collaborators` | `remove(kind, id, collabId)`       | ✓   | ✓    | —     | —      |
| `sharedWithMe`  | `()`                               | ✓   | —    | —     | —      |
| `invites`       | `list / create / revoke`           | ✓   | —    | —     | —      |
| `s3Keys`        | `list / create / revoke`           | ✓   | ✓    | ✓     | ✓      |
| `apps` (PATs)   | `list / create / revoke`           | —   | ✓    | —     | —      |

For anything marked `—`, hit the REST endpoint directly. The SDK's `StohrError` and bearer-token injection still help — every SDK exposes its HTTP client or accepts a custom fetcher.

## Quick start, side-by-side

```ts
// TypeScript
import { createClient } from "@stohr/sdk"

const stohr = createClient({ baseUrl: "https://stohr.io/api" })
await stohr.auth.login("you@example.com", "your-password")

const blob = new Blob(["hello, stohr"], { type: "text/plain" })
const [uploaded] = await stohr.files.upload({ file: blob, name: "hello.txt" })

const folder = await stohr.folders.create("Italy 2025", null, { kind: "photos", isPublic: true })
await stohr.collaborators.add("folder", folder.id, "alice@example.com", "editor")
```

```dart
// Dart / Flutter
import 'dart:typed_data';
import 'package:stohr/stohr.dart';

final client = StohrClient(baseUrl: 'https://stohr.io/api');
await client.login('you@example.com', 'your-password');

final bytes = Uint8List.fromList('hello, stohr'.codeUnits);
await client.uploadFile(bytes: bytes, name: 'hello.txt');

final folder = await client.createFolder('Italy 2025', kind: 'photos', isPublic: true);
await client.addCollaborator('folder', folder.id, 'alice@example.com', 'editor');
client.close();
```

```swift
// Swift
import Stohr

let client = StohrClient(baseURL: URL(string: "https://stohr.io/api")!)
_ = try await client.login(identity: "you@example.com", password: "your-password")

let bytes = "hello, stohr".data(using: .utf8)!
_ = try await client.uploadFile(data: bytes, name: "hello.txt")

let folder = try await client.createFolder(name: "Italy 2025", kind: "photos", isPublic: true)
```

```kotlin
// Kotlin
import io.stohr.StohrClient

val client = StohrClient(baseUrl = "https://stohr.io/api")
client.login("you@example.com", "your-password")

val uploaded = client.uploadFile(
    bytes = "hello, stohr".toByteArray(),
    name = "hello.txt",
)

val folder = client.createFolder("Italy 2025", kind = "photos", isPublic = true)
client.close()
```

## Auth

Every SDK returns a token from `login` / `signup` and stores it internally — every subsequent call attaches `Authorization: Bearer <token>`. To restore from your own storage:

```ts
stohr.setToken(saved)
const t = stohr.getToken()
```

```dart
client.token = saved;
final t = client.token;
```

```swift
await client.setToken(saved)
let t = await client.currentToken()
```

```kotlin
client.setToken(saved)
val t = client.token()
```

### MFA login (Dart)

The Dart SDK has a typed MFA flow today; the other three currently round-trip raw JSON for `POST /login/mfa`.

```dart
final result = await client.login('you', 'password');
if (result is MfaChallenge) {
  await client.loginMfa(mfaToken: result.mfaToken, code: '123456');
}
```

For TS / Swift / Kotlin: when `POST /login` returns `{ mfa_required: true, mfa_token }`, post that token plus the user's TOTP `code` (or `backup_code`) to `/login/mfa` to receive the real session token, then call `setToken(...)`.

## Errors

Each SDK throws a typed `StohrError` carrying the HTTP status and the parsed body so callers can branch on quotas, expired tokens, or 422 validation:

```ts
import { StohrError } from "@stohr/sdk"

try {
  await stohr.files.upload({ file: huge, name: "huge.bin" })
} catch (e) {
  if (e instanceof StohrError && e.status === 402) {
    console.log("over quota:", e.body)
  }
}
```

```dart
try {
  await client.uploadFile(bytes: huge, name: 'huge.bin');
} on StohrError catch (e) {
  if (e.status == 402) print('over quota: ${e.body}');
}
```

```swift
do {
  _ = try await client.uploadFile(data: huge, name: "huge.bin")
} catch let error as StohrError where error.status == 402 {
  print("over quota:", error.message)
}
```

```kotlin
try {
  client.uploadFile(bytes = huge, name = "huge.bin")
} catch (e: StohrError) {
  if (e.status == 402) println("over quota: ${e.body}")
}
```

Common status codes worth handling: `401` (bad / expired token), `402` (quota exceeded — body has `quota_bytes / used_bytes / breakdown`), `403` (forbidden, also "insufficient OAuth scope"), `409` (conflict — duplicate name or username), `422` (validation), `429` (rate-limited — body has `retry_after` seconds).

## Custom HTTP client

Each SDK accepts a swap-in HTTP layer for tests, polyfills, proxies, or alternate engines.

```ts
const stohr = createClient({
  baseUrl: "https://stohr.io/api",
  fetch: (url, init) => fetch(url, { ...init, mode: "cors" }),
})
```

```dart
final client = StohrClient(client: myHttpClient);   // any package:http Client
```

```swift
let client = StohrClient(baseURL: url, session: myHTTPSession)   // conforms to HTTPSession
```

```kotlin
import io.ktor.client.engine.okhttp.OkHttp
val client = StohrClient(engine = OkHttp.create())   // any Ktor engine
```

## Versioning

All SDKs target API `v1`. Breaking changes will bump the SDK major version; patch releases match across languages where possible.

## Adding a new endpoint

When you add a route to the backend (`src/<feature>/index.ts`), add the matching operation to **all four** SDKs in the same PR. Keep grouping (`folders.create` etc.) consistent across languages — and update the coverage table in this file. If an op can't reasonably be expressed in one language, drop it into that SDK's `client.{ts,dart}` / `Client.{swift,kt}` directly and note the gap.

## See also

- [`sdks/README.md`](../sdks/README.md) — top-level SDK monorepo overview
- [REST API reference](API.md) — the full endpoint catalog the SDKs wrap
- [S3-compatible endpoints](S3.md) — drop-in for `aws-cli` / `boto3` if SDK ergonomics aren't what you need
- [OAuth 2.0](OAUTH.md) — the auth flow for third-party apps acting on a user's behalf
