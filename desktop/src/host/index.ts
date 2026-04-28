import { on, send, send as sendEvent } from "butterframework"
import { randomBytes } from "node:crypto"
import { loadConfig, saveConfig, type Config } from "./config.ts"
import {
  buildAuthorizeUrl,
  clearTokens,
  consumeFlow,
  exchangeCode,
  loadTokens,
  newPkcePair,
  persistTokens,
  startFlow,
} from "./oauth.ts"
import { me } from "./api.ts"
import { captureAndShare, listRecents, remember, type CaptureMode } from "./capture.ts"

let config: Config

const TRAY_ID = "stohr-tray"
const SHORTCUT_ID = "stohr-capture"

const trayItems = (signedIn: boolean) => [
  { label: signedIn ? "Capture region" : "Sign in to Stohr…", action: signedIn ? "tray:capture-region" : "tray:signin" },
  ...(signedIn ? [
    { label: "Capture window", action: "tray:capture-window" },
    { label: "Capture full screen", action: "tray:capture-screen" },
    { separator: true } as const,
    { label: "Recent captures…", action: "tray:show-recents" },
    { separator: true } as const,
    { label: "Settings…", action: "tray:settings" },
    { label: "Sign out", action: "tray:signout" },
  ] : [
    { separator: true } as const,
    { label: "Settings…", action: "tray:settings" },
  ]),
  { separator: true } as const,
  { label: "Quit", action: "tray:quit" },
]

const refreshTray = async (signedIn: boolean) => {
  await send("tray:set" as any, {
    title: "S",
    tooltip: signedIn ? "Stohr" : "Stohr — signed out",
    items: trayItems(signedIn),
  })
}

const isSignedIn = async (): Promise<boolean> => {
  const t = await loadTokens()
  return !!t
}

const notify = (title: string, body?: string) => {
  void send("notify:send" as any, { title, ...(body ? { body } : {}) })
}

const writeClipboard = (value: string) => send("clipboard:write" as any, value)

const beginSignIn = async () => {
  if (!config.clientId) {
    notify("Stohr setup needed", "Open Settings and paste a client ID first.")
    return
  }
  const { verifier, challenge } = newPkcePair()
  const state = randomBytes(16).toString("hex")
  startFlow(verifier, state)
  const url = buildAuthorizeUrl(config, challenge, state)
  await send("shell:openurl" as any, url)
}

const handleOAuthCallback = async (url: string) => {
  let parsed: URL
  try { parsed = new URL(url) } catch { return }
  if (parsed.protocol !== "stohrshot:") return
  if (parsed.pathname.replace(/\//g, "") !== "oauthcallback") return

  const code = parsed.searchParams.get("code")
  const state = parsed.searchParams.get("state")
  const error = parsed.searchParams.get("error")
  if (error) {
    notify("Sign-in cancelled", parsed.searchParams.get("error_description") ?? error)
    return
  }
  if (!code || !state) {
    notify("Sign-in failed", "Missing code or state in callback.")
    return
  }
  const flow = consumeFlow(state)
  if (!flow) {
    notify("Sign-in failed", "Stale or unknown OAuth flow — try again.")
    return
  }
  try {
    const tokens = await exchangeCode(config, code, flow.verifier)
    await persistTokens(tokens)
    const u = await me(config)
    notify("Signed in", `Welcome, @${u.username}.`)
    await refreshTray(true)
    sendEvent("auth:changed" as any, { signedIn: true, user: u })
  } catch (e: any) {
    notify("Sign-in failed", e?.message ?? String(e))
  }
}

const runCapture = async (mode: CaptureMode) => {
  if (!(await isSignedIn())) {
    notify("Sign in first", "Open the menu bar item and choose Sign in.")
    return
  }
  try {
    const result = await captureAndShare(config, mode)
    if (!result) return  // user cancelled
    remember({ filename: result.filename, shareUrl: result.shareUrl, fileId: result.fileId })
    await writeClipboard(result.shareUrl)
    notify("Link copied", result.shareUrl)
    sendEvent("capture:done" as any, result)
  } catch (e: any) {
    notify("Capture failed", e?.message ?? String(e))
  }
}

const init = async () => {
  config = await loadConfig()
  const signedIn = await isSignedIn()

  await refreshTray(signedIn)

  // Global hotkey: Cmd+Shift+8 (does not collide with macOS's native Cmd+Shift+3/4/5).
  await send("shortcut:register" as any, {
    id: SHORTCUT_ID,
    shortcut: { key: "8", modifiers: ["cmd", "shift"] },
  })

  on("shortcut:triggered", (data: any) => {
    if (data?.id === SHORTCUT_ID) void runCapture("region")
  })

  // Tray actions.
  on("tray:action", (data: any) => {
    const action = data?.action as string | undefined
    switch (action) {
      case "tray:signin": void beginSignIn(); break
      case "tray:capture-region": void runCapture("region"); break
      case "tray:capture-window": void runCapture("window"); break
      case "tray:capture-screen": void runCapture("screen"); break
      case "tray:show-recents":
      case "tray:settings":
        sendEvent("window:show" as any, { focus: true })
        break
      case "tray:signout":
        void (async () => {
          await clearTokens()
          await refreshTray(false)
          sendEvent("auth:changed" as any, { signedIn: false })
          notify("Signed out")
        })()
        break
      case "tray:quit":
        sendEvent("app:quit" as any, {})
        break
    }
  })

  // Deep-link callback from the OS (stohrshot://oauth/callback?code=…&state=…).
  on("app:openurl", (data: any) => {
    const u = (data as { url?: string })?.url
    if (typeof u === "string") void handleOAuthCallback(u)
  })

  // Webview-driven IPC.
  on("auth:status", async () => {
    const signedIn = await isSignedIn()
    if (!signedIn) return { signedIn: false, config }
    try {
      const u = await me(config)
      return { signedIn: true, config, user: u, recents: listRecents() }
    } catch {
      return { signedIn: false, config }
    }
  })

  on("auth:server", async (input: any) => {
    config = { ...config, serverUrl: String(input?.url ?? "").trim() || config.serverUrl }
    await saveConfig(config)
    return { ok: true, config }
  })

  on("auth:client", async (input: any) => {
    config = { ...config, clientId: String(input?.clientId ?? "").trim() || null }
    await saveConfig(config)
    return { ok: true, config }
  })

  on("auth:signin", async () => {
    await beginSignIn()
    return { ok: true }
  })

  on("auth:signout", async () => {
    await clearTokens()
    await refreshTray(false)
    return { ok: true }
  })

  on("capture:run", async (input: any) => {
    await runCapture((input?.mode as CaptureMode) ?? "region")
    return { ok: true }
  })

  on("capture:recent", async () => listRecents())
}

void init()
