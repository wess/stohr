# Stohr (Swift SDK)

Swift SDK for [Stohr](https://stohr.io). Targets iOS 15+, macOS 12+, tvOS 15+, watchOS 8+.

## Install (Swift Package Manager)

`File → Add Packages…` and point at this repo, or in `Package.swift`:

```swift
.package(url: "https://github.com/wess/stohr.git", from: "0.1.0")
```

then add `"Stohr"` to your target dependencies.

## Quick start

```swift
import Stohr

let client = StohrClient(baseURL: URL(string: "https://stohr.io/api")!)

let auth = try await client.login(identity: "you@example.com", password: "secret")

let bytes = "hello, stohr".data(using: .utf8)!
let uploaded = try await client.uploadFile(data: bytes, name: "hello.txt")

let folder = try await client.createFolder(name: "Italy 2025", kind: "photos", isPublic: true)
```

## Auth

```swift
try await client.signup(
    name: "You",
    username: "you",
    email: "you@example.com",
    password: "longenough",
    inviteToken: "abc123"   // required unless first user
)

try await client.login(identity: "you@example.com", password: "secret")
await client.setToken(savedToken)
```

## Errors

`StohrError` carries `status` and `message`:

```swift
do {
    _ = try await client.uploadFile(data: huge, name: "huge.bin")
} catch let error as StohrError where error.status == 402 {
    print("over quota:", error.message)
}
```

## Tests

```sh
swift test
```
