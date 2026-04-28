# Stohr Desktop (`stohrshot`)

Menu-bar / system-tray app for capturing screenshots and uploading them to your Stohr instance with one keypress. Built on [Butter](https://github.com/wess/butter) (TypeScript desktop framework, native webview, single-file binary).

## What it does

- Sits in the menu bar / system tray
- Hit <kbd>⌘⇧8</kbd> (or pick from the menu) → OS-native screenshot picker
- Auto-uploads the PNG to your Stohr Screenshots folder
- Auto-creates a 30-day public share link, copies it to your clipboard
- Notifies you with the link
- All authentication via OAuth 2.0 + PKCE — never sees your password, tokens stored in the OS keychain

Currently macOS only (uses `screencapture(1)` + `security` keychain CLI). Linux/Windows port is straightforward (libsecret + `gnome-screenshot` / Win32 PrintScreen) — open an issue when you need it.

## First-run setup

The app needs to know **where** your Stohr instance is and **which OAuth client** to authenticate as.

1. Sign in to your Stohr instance as the operator (the owner account).
2. Go to **Settings → Developer → OAuth applications → Register new OAuth client** and create one:
   - **Name**: `Stohrshot Desktop`
   - **Redirect URIs**: `stohrshot://oauth/callback` (exactly that)
   - **Scopes**: `read`, `write`, `share`
   - **First-party app**: ✓ (skips the consent screen for your operators — set to false if you want explicit consent each time)
   - **Public client**: ✓ (PKCE — no secret needed)
3. Copy the `client_id` (`cli_…`).
4. Launch this app. Paste the **Server URL** (e.g. `https://stohr.example.com/api`) and the **Client ID**. Click **Sign in via browser**.
5. Your browser opens the Stohr authorize page. Approve. The browser hands the redirect (`stohrshot://oauth/callback?code=…`) back to the app via the URL scheme.
6. Done. The menu-bar item now shows capture options.

Tokens are stored in the macOS Keychain under service `io.stohr.shot`. Access tokens last 1 hour and auto-refresh; refresh tokens last 30 days and rotate on every refresh.

## Develop

```sh
cd desktop
bun install
bun run dev      # opens the window with hot reload
```

## Build

```sh
bun run build      # single binary at dist/
butter bundle      # macOS .app bundle at dist/stohrshot.app
```

## Code map

```
src/
  host/                  # Bun process — no DOM
    index.ts             # entry: wires tray, shortcut, deep-link, IPC
    config.ts            # ~/.config/stohrshot/config.json (server, client_id)
    keychain.ts          # macOS `security` CLI wrapper (token storage)
    oauth.ts             # PKCE pair, /oauth/token exchange, refresh, persist
    api.ts               # typed Stohr API client w/ auto-refresh
    capture.ts           # screencapture(1) → upload → share → recents list
    menu.ts              # native macOS app menu (minimal — tray is primary)
  app/                   # webview (settings + recents)
    index.html
    main.ts
    styles.css
    splash.html
  env.d.ts               # window.butter typings
butter.yaml              # window/bundle/security/url-scheme config
```

## Security

- **PKCE is mandatory.** No client secret is ever stored on disk.
- Tokens live in the OS keychain (macOS `security`); fallback to `~/.config/stohrshot/secrets.json` with `0600` perms on Linux until libsecret integration lands.
- The OAuth `redirect_uri` is exact-match against what's registered on the server — no substring matching.
- The `state` parameter is checked on the redirect to prevent cross-site request forgery.
- The deep-link handler only accepts `stohrshot://oauth/callback` URLs.
