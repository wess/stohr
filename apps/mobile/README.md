# Stohr mobile

iOS + Android client for [Stohr](../../README.md), built with Flutter.

Browse folders, upload from the camera roll, share files, and manage your account against a self-hosted Stohr instance.

## Develop

```sh
cd apps/mobile
flutter pub get
flutter run         # picks the connected device
```

The app authenticates with your Stohr instance via the regular login + JWT flow; long-lived sessions are stored on the platform keychain.

## See also

- [Stohr API](../../docs/API.md) — REST surface this app calls
- [SDKs](../../sdks/README.md) — the [Dart SDK](../../sdks/dart/README.md) wraps the same operations
