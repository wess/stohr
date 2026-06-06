// GitHub OAuth helpers. GitHub is a plain OAuth2 provider (no OIDC, no
// PKCE), so we exchange the code for an access token and then read the
// profile + verified primary email from the REST API.

const GITHUB_AUTHORIZE = "https://github.com/login/oauth/authorize"
const GITHUB_TOKEN = "https://github.com/login/oauth/access_token"
const GITHUB_USER = "https://api.github.com/user"
const GITHUB_EMAILS = "https://api.github.com/user/emails"

export const githubAuthorizeUrl = (clientId: string, redirectUri: string, state: string): string => {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: "read:user user:email",
    state,
    allow_signup: "true",
  })
  return `${GITHUB_AUTHORIZE}?${params.toString()}`
}

export const exchangeGithubCode = async (opts: {
  clientId: string
  clientSecret: string
  code: string
  redirectUri: string
}): Promise<string> => {
  const res = await fetch(GITHUB_TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      code: opts.code,
      redirect_uri: opts.redirectUri,
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`GitHub token exchange failed: ${res.status} ${body.slice(0, 200)}`)
  }
  const json = (await res.json()) as { access_token?: string; error?: string; error_description?: string }
  if (!json.access_token) {
    throw new Error(json.error_description || json.error || "GitHub did not return an access token")
  }
  return json.access_token
}

type GithubUser = {
  id: number
  login: string
  name: string | null
  email: string | null
}

type GithubEmail = {
  email: string
  primary: boolean
  verified: boolean
}

export type GithubProfile = {
  subject: string
  email: string | null
  display_name: string | null
  preferred_username: string | null
}

const ghHeaders = (accessToken: string): HeadersInit => ({
  authorization: `Bearer ${accessToken}`,
  accept: "application/vnd.github+json",
  "user-agent": "stohr",
  "x-github-api-version": "2022-11-28",
})

const primaryVerifiedEmail = (emails: GithubEmail[]): string | null => {
  const primary = emails.find(e => e.primary && e.verified)
  if (primary) return primary.email.toLowerCase()
  const anyVerified = emails.find(e => e.verified)
  return anyVerified ? anyVerified.email.toLowerCase() : null
}

export const fetchGithubProfile = async (accessToken: string): Promise<GithubProfile> => {
  const userRes = await fetch(GITHUB_USER, { headers: ghHeaders(accessToken) })
  if (!userRes.ok) throw new Error(`GitHub user fetch failed: ${userRes.status}`)
  const user = (await userRes.json()) as GithubUser

  let email = user.email ? user.email.toLowerCase() : null
  // Public-profile email is often null; pull the verified primary from the
  // dedicated endpoint (granted by the user:email scope).
  const emailsRes = await fetch(GITHUB_EMAILS, { headers: ghHeaders(accessToken) })
  if (emailsRes.ok) {
    const emails = (await emailsRes.json()) as GithubEmail[]
    const found = primaryVerifiedEmail(emails)
    if (found) email = found
  }

  return {
    subject: String(user.id),
    email,
    display_name: user.name ?? user.login,
    preferred_username: user.login,
  }
}
