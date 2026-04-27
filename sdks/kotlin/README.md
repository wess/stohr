# io.stohr (Kotlin SDK)

Kotlin SDK for [Stohr](https://stohr.io). Targets Android (API 24+) and any JVM 17+.

## Install (Gradle)

```kotlin
dependencies {
    implementation("io.stohr:stohr-sdk:0.1.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.7.3")
}
```

## Quick start

```kotlin
import io.stohr.StohrClient

suspend fun main() {
    val client = StohrClient(baseUrl = "https://stohr.io/api")

    client.login("you@example.com", "your-password")

    val uploaded = client.uploadFile(
        bytes = "hello, stohr".toByteArray(),
        name = "hello.txt",
    )

    val folder = client.createFolder("Italy 2025", kind = "photos", isPublic = true)
    client.close()
}
```

## Auth

```kotlin
client.signup(
    name = "You",
    username = "you",
    email = "you@example.com",
    password = "longenough",
    inviteToken = "abc123",     // required unless first user
)

client.login(identity = "you@example.com", password = "secret")
client.setToken(savedToken)
```

## Errors

```kotlin
try {
    client.uploadFile(bytes = huge, name = "huge.bin")
} catch (e: StohrError) {
    if (e.status == 402) println("over quota: ${e.body}")
}
```

## Tests

```sh
./gradlew test
```

## Engine

The default engine is Ktor CIO. On Android you may want to swap it:

```kotlin
import io.ktor.client.engine.okhttp.OkHttp

val client = StohrClient(engine = OkHttp.create())
```
