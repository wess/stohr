import React from "react"
import { createRoot } from "react-dom/client"
import { Landing } from "./index"
import { Developers } from "./developers"
import { Setup } from "./setup"

// Dev-mode fallback: build.ts replaces `<!-- STATIC_LINKS -->` with real
// <link> tags at production build time. The dev server can't (Bun's HTML
// bundler refuses to resolve the absolute paths). Inject them here when
// they're missing so dev pages don't FOUC.
if (!document.head.querySelector("link[rel=stylesheet]")) {
  const css = document.createElement("link")
  css.rel = "stylesheet"
  css.href = "/style.css"
  document.head.appendChild(css)
  const icon = document.createElement("link")
  icon.rel = "icon"
  icon.type = "image/png"
  icon.href = "/assets/logo.png"
  document.head.appendChild(icon)
}

const path = window.location.pathname.replace(/\/+$/, "") || "/"

const pickPage = (): React.ReactElement => {
  if (path === "/developers") return <Developers />
  if (path === "/setup") return <Setup />
  return <Landing />
}

const root = createRoot(document.getElementById("app")!)
root.render(<React.StrictMode>{pickPage()}</React.StrictMode>)
