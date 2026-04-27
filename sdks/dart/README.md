# stohr (Dart SDK)

Dart/Flutter SDK for [Stohr](https://stohr.io).

## Install

```yaml
dependencies:
  stohr: ^0.1.0
```

## Quick start

```dart
import 'dart:typed_data';
import 'package:stohr/stohr.dart';

void main() async {
  final client = StohrClient(baseUrl: 'https://stohr.io/api');

  await client.login('you@example.com', 'your-password');

  final bytes = Uint8List.fromList('hello, stohr'.codeUnits);
  final uploaded = await client.uploadFile(bytes: bytes, name: 'hello.txt');

  final folder = await client.createFolder('Italy 2025', kind: 'photos', isPublic: true);
  await client.addCollaborator('folder', folder.id, 'alice@example.com', 'editor');

  client.close();
}
```

## Auth

```dart
await client.signup(
  name: 'You',
  username: 'you',
  email: 'you@example.com',
  password: 'longenough',
  inviteToken: 'abc123', // required unless first user
);

await client.login('you@example.com', 'password'); // identity = email or username
client.token = savedToken;                          // restore from storage
```

## Errors

`StohrError` exposes `.status` and `.body` for inspection:

```dart
try {
  await client.uploadFile(bytes: huge, name: 'huge.bin');
} on StohrError catch (e) {
  if (e.status == 402) {
    print('over quota: ${e.body}');
  }
}
```

## Tests

```sh
dart test
```
