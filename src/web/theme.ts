export type Theme = "light" | "dark" | "system"

const KEY = "stohr_theme"

export const getTheme = (): Theme => {
  const v = localStorage.getItem(KEY)
  return v === "light" || v === "dark" ? v : "system"
}

export const applyTheme = (theme: Theme) => {
  const dark = theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches)
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light")
}

export const setTheme = (theme: Theme) => {
  if (theme === "system") localStorage.removeItem(KEY)
  else localStorage.setItem(KEY, theme)
  applyTheme(theme)
}

window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (getTheme() === "system") applyTheme("system")
})
