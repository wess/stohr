# SDKs

Four official client libraries in [`sdks/`](../sdks/README.md). All wrap the same REST surface in idiomatic per-language style.

| Language | Path | Targets |
| --- | --- | --- |
| TypeScript | [`sdks/typescript`](../sdks/typescript/README.md) | Bun, Deno, Node 20+, browsers |
| Dart | [`sdks/dart`](../sdks/dart/README.md) | Flutter, Dart 3+ |
| Swift | [`sdks/swift`](../sdks/swift/README.md) | iOS 15+, macOS 12+, tvOS 15+, watchOS 8+ |
| Kotlin | [`sdks/kotlin`](../sdks/kotlin/README.md) | Android, JVM 17+ |

## Common shape

All SDKs expose the same operations:

```
auth        login, signup
me          get, update, subscription, changePassword
folders     list, get, create, rename, move, delete
files       list, get, upload, download, thumbnail, rename, move, delete, versions
shares      list, create, delete
collaborators  list, add, remove
sharedWithMe()
invites     list, create, revoke
s3Keys      list, create, revoke
```

## Auth

All SDKs return a token from `login`/`signup` and store it internally. Restore from your own storage with `setToken(t)`. Every subsequent call sends `Authorization: Bearer <token>`.

## Errors

Each SDK throws a typed error (`StohrError`) carrying `status` (HTTP code) and the parsed body (when JSON). Use them to handle quota errors, expired tokens, etc:

```ts
// TypeScript
try {
  await stohr.files.upload({ file: huge, name: "huge.bin" })
} catch (e) {
  if (e instanceof StohrError && e.status === 402) {
    console.log("over quota:", e.body)
  }
}
```

```swift
// Swift
do {
    _ = try await client.uploadFile(data: huge, name: "huge.bin")
} catch let error as StohrError where error.status == 402 {
    print("over quota:", error.message)
}
```

## Adding a new endpoint

When you add a route to the backend (`src/<feature>/index.ts`), add the same operation to all four SDKs in parallel. Keep the operation grouping (`folders.create` etc.) consistent across languages — if you can't, add it to the `client.ts`/`Client.swift`/`Client.kt`/`client.dart` directly and link from each SDK's `README.md`.
