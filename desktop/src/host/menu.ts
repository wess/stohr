import type { Menu } from "butterframework/types"

// macOS app menu — kept minimal since the primary surface is the tray.
export default [
  {
    label: "Stohr",
    items: [
      { label: "About Stohr", action: "app:about" },
      { separator: true },
      { label: "Settings…", action: "app:settings", shortcut: "CmdOrCtrl+," },
      { separator: true },
      { label: "Quit Stohr", action: "app:quit", shortcut: "CmdOrCtrl+Q" },
    ],
  },
  {
    label: "Capture",
    items: [
      { label: "Capture region", action: "capture:region", shortcut: "CmdOrCtrl+Shift+8" },
      { label: "Capture window", action: "capture:window" },
      { label: "Capture full screen", action: "capture:screen" },
    ],
  },
] satisfies Menu
