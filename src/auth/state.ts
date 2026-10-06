import type { Conn } from "@atlas/server"
import { putHeader } from "@atlas/server"
import { requestBaseUrl } from "../teams/request.ts"
import { randomToken } from "../util/token.ts"

const COOKIE = "stohr_sso_state"

const browserNonce = (req: Request): string => {
  const nonce = new URL(req.url).searchParams.get("browser_nonce") ?? ""
  return /^[a-f0-9-]{36}$/i.test(nonce) ? nonce : randomToken(24)
}

const stateCookie = (req: Request): string | null => {
  const raw = req.headers
    .get("cookie")
    ?.split(";")
    .map(c => c.trim())
    .find(c => c.startsWith(`${COOKIE}=`))
  if (!raw) return null
  try {
    return decodeURIComponent(raw.slice(COOKIE.length + 1))
  } catch {
    return null
  }
}

export const bindLoginState = (c: Conn, state: string): Conn => {
  const secure = new URL(requestBaseUrl(c.request, c.request.url)).protocol === "https:" ? "; Secure" : ""
  const value = encodeURIComponent(`${state}:${browserNonce(c.request)}`)
  return putHeader(c, "set-cookie", `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${secure}`)
}

export const loginStateNonce = (req: Request, state: string): string | null => {
  const value = stateCookie(req)
  if (!value?.startsWith(`${state}:`)) return null
  return value.slice(state.length + 1) || null
}

export const clearLoginState = (c: Conn): Conn => {
  const secure = new URL(requestBaseUrl(c.request, c.request.url)).protocol === "https:" ? "; Secure" : ""
  return putHeader(c, "set-cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`)
}
