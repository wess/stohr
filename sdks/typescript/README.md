# @stohr/sdk

TypeScript SDK for [Stohr](https://stohr.io). Works in Bun, Deno, Node 20+, and modern browsers.

## Install

```sh
bun add @stohr/sdk
# or
npm install @stohr/sdk
```

## Quick start

```ts
import { createClient } from "@stohr/sdk"

const stohr = createClient({ baseUrl: "https://stohr.io/api" })

await stohr.auth.login("you@example.com", "your-password")

// Upload a file
const file = new Blob(["hello, stohr"], { type: "text/plain" })
const [uploaded] = await stohr.files.upload({ file, name: "hello.txt" })

// Make a folder a photos gallery
const folder = await stohr.folders.create("Italy 2025", null, { kind: "photos", isPublic: true })

// Share with a teammate
await stohr.collaborators.add("folder", folder.id, "alice@example.com", "editor")
```

## Auth

```ts
await stohr.auth.signup({
  name: "You",
  username: "you",
  email: "you@example.com",
  password: "longenough",
  inviteToken: "abc123", // required unless first user
})

await stohr.auth.login("you@example.com" /* or username */, "password")
stohr.setToken(savedToken)             // restore from storage
const t = stohr.getToken()
```

## API

The client groups operations by resource: `auth`, `me`, `folders`, `files`,
`shares`, `collaborators`, `invites`, `s3Keys`, plus `sharedWithMe()`.

Errors throw `StohrError` with `.status` and `.body` for inspection:

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

## Custom fetch (testing, polyfills, proxies)

```ts
const stohr = createClient({
  baseUrl: "https://stohr.io/api",
  fetch: (url, init) => fetch(url, { ...init, mode: "cors" }),
})
```

## Tests

```sh
bun test
```
