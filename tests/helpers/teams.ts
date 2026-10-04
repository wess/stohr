import { expect } from "bun:test"
import type { App } from "./http.ts"
import { callJson } from "./http.ts"

// Host routing under test: the root team answers on ROOT and on any host
// not under it (test.local, the default); team `acme` answers on acme.ROOT.
export const ROOT = "stohr.test"
export const hostOf = (slug: string) => `${slug}.${ROOT}`

export type Session = { id: number; token: string }

// first signup on the root host — the instance owner
export const signupOwner = async (app: App, username = "owner"): Promise<Session> => {
  const res = await callJson(app, "/signup", {
    method: "POST",
    host: ROOT,
    body: { name: username, username, email: `${username}@example.com`, password: "password123" },
  })
  expect(res.status).toBe(201)
  return res.body as Session
}

export type CreatedTeam = {
  team: { id: number; slug: string; name: string; quota_bytes: number | null }
  admin: { id: number; email: string; username: string }
  set_password_url: string
}

export const createTeam = async (
  app: App,
  owner: Session,
  slug: string,
  extra: Record<string, unknown> = {},
): Promise<CreatedTeam> => {
  const res = await callJson(app, "/admin/teams", {
    method: "POST",
    host: ROOT,
    token: owner.token,
    body: { slug, name: slug.toUpperCase(), admin_email: `admin@${slug}.example`, ...extra },
  })
  expect(res.status).toBe(201)
  return res.body as CreatedTeam
}

// follow the one-time link: set the admin's password on the team host
export const setPassword = async (app: App, created: CreatedTeam, password = "password123"): Promise<void> => {
  const token = new URL(created.set_password_url).searchParams.get("token")!
  const res = await callJson(app, "/password/reset", {
    method: "POST",
    host: hostOf(created.team.slug),
    body: { token, new_password: password },
  })
  expect(res.status).toBe(200)
}

export const login = async (app: App, host: string, identity: string, password = "password123") =>
  callJson(app, "/login", { method: "POST", host, body: { identity, password } })

// team + its admin, signed in on the team host
export const teamWithAdmin = async (app: App, owner: Session, slug: string, extra: Record<string, unknown> = {}) => {
  const created = await createTeam(app, owner, slug, extra)
  await setPassword(app, created)
  const res = await login(app, hostOf(slug), created.admin.email)
  expect(res.status).toBe(200)
  return { created, admin: res.body as Session, host: hostOf(slug) }
}

// a plain member added by the team admin, signed in on the team host
export const addMember = async (app: App, host: string, admin: Session, username: string): Promise<Session> => {
  const made = await callJson(app, "/team/users", {
    method: "POST",
    host,
    token: admin.token,
    body: { email: `${username}@member.example`, username, password: "password123" },
  })
  expect(made.status).toBe(201)
  const res = await login(app, host, `${username}@member.example`)
  expect(res.status).toBe(200)
  return res.body as Session
}
