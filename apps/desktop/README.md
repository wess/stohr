# Stohrshot

Menu-bar screenshot client for [Stohr](../../README.md) — capture, upload, get a shareable link.

Built with Flutter for macOS. Authenticates against a Stohr instance via OAuth 2.0 (device flow) and uploads into the user's `Screenshots` folder, then mints a public share link copied to the clipboard.

## Develop

```sh
cd apps/desktop
flutter pub get
flutter run -d macos
```

Point it at a running Stohr API (default `http://localhost:3000`) the first time it launches.

## See also

- [OAuth integration](../../docs/OAUTH.md) — device flow used here
- [Stohr API](../../docs/API.md) — file upload + share endpoints
