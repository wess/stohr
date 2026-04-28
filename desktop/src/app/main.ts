type AuthStatus = {
  signedIn: boolean
  config: { serverUrl: string; clientId: string | null; redirectUri: string }
  user?: { id: number; username: string; email: string; name: string }
  recents?: Array<{ filename: string; shareUrl: string; fileId: number; createdAt: number }>
}

const byId = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T

const showMsg = (kind: "ok" | "err", text: string) => {
  const el = byId("msg")
  el.className = `msg ${kind}`
  el.textContent = text
  el.hidden = false
  setTimeout(() => { el.hidden = true }, 4000)
}

const setStatus = (text: string) => { byId("status").textContent = text }

const renderRecents = (recents: AuthStatus["recents"] = []) => {
  const list = byId("recents") as HTMLOListElement
  list.innerHTML = ""
  if (recents.length === 0) {
    const li = document.createElement("li")
    li.className = "empty muted"
    li.textContent = "Nothing yet — your screenshots will appear here."
    list.appendChild(li)
    return
  }
  for (const r of recents) {
    const li = document.createElement("li")
    const fn = document.createElement("span")
    fn.className = "filename"
    fn.textContent = r.filename
    const url = document.createElement("span")
    url.className = "url"
    url.textContent = r.shareUrl
    url.addEventListener("click", async () => {
      await window.butter.clipboard.write(r.shareUrl)
      showMsg("ok", "Link copied to clipboard")
    })
    const when = document.createElement("span")
    when.className = "when"
    when.textContent = new Date(r.createdAt).toLocaleString()
    li.append(fn, url, when)
    list.appendChild(li)
  }
}

const render = (s: AuthStatus) => {
  const serverInput = byId<HTMLInputElement>("server-url")
  const clientInput = byId<HTMLInputElement>("client-id")
  serverInput.value = s.config.serverUrl
  clientInput.value = s.config.clientId ?? ""

  if (s.signedIn && s.user) {
    byId("signed-out").hidden = true
    byId("signed-in").hidden = false
    byId("who").textContent = `@${s.user.username}`
    setStatus("Ready.")
    renderRecents(s.recents ?? [])
  } else {
    byId("signed-out").hidden = false
    byId("signed-in").hidden = true
    setStatus(s.config.clientId ? "Sign in to start capturing." : "Configure server + client ID, then sign in.")
  }
}

const refresh = async () => {
  const s = await window.butter.invoke<AuthStatus>("auth:status")
  render(s)
}

const init = async () => {
  await refresh()

  byId("server-url").addEventListener("change", async (e) => {
    const url = (e.target as HTMLInputElement).value
    await window.butter.invoke("auth:server", { url })
  })

  byId("client-id").addEventListener("change", async (e) => {
    const clientId = (e.target as HTMLInputElement).value
    await window.butter.invoke("auth:client", { clientId })
  })

  byId("sign-in-btn").addEventListener("click", async () => {
    const url = (byId("server-url") as HTMLInputElement).value.trim()
    const id = (byId("client-id") as HTMLInputElement).value.trim()
    if (!url) return showMsg("err", "Server URL is required")
    if (!id) return showMsg("err", "Client ID is required (Settings → Developer → OAuth applications on your Stohr instance)")
    await window.butter.invoke("auth:server", { url })
    await window.butter.invoke("auth:client", { clientId: id })
    await window.butter.invoke("auth:signin")
    showMsg("ok", "Browser opened for authorization…")
  })

  byId("sign-out-btn").addEventListener("click", async () => {
    await window.butter.invoke("auth:signout")
    await refresh()
  })

  for (const btn of document.querySelectorAll<HTMLButtonElement>(".actions button")) {
    btn.addEventListener("click", async () => {
      const mode = btn.dataset.mode as "region" | "window" | "screen"
      await window.butter.invoke("capture:run", { mode })
    })
  }

  // Host pushes events when auth or captures change.
  window.butter.on("auth:changed", () => { void refresh() })
  window.butter.on("capture:done", () => { void refresh() })
}

void init()
