// Social sign-in is configured purely from environment variables — no
// DB-stored secrets, no admin UI. A provider is enabled only when both its
// CLIENT_ID and CLIENT_SECRET are present; otherwise its routes report
// disabled and the SPA hides the button.

export type SocialProvider = "google" | "github"

export type SocialProviderConfig = {
  provider: SocialProvider
  client_id: string
  client_secret: string
  label: string
  auto_provision: boolean
}

const readPair = (idVar: string, secretVar: string): { id: string; secret: string } | null => {
  const id = (process.env[idVar] ?? "").trim()
  const secret = (process.env[secretVar] ?? "").trim()
  if (!id || !secret) return null
  return { id, secret }
}

const autoProvision = (): boolean => {
  // Default on, matching the OIDC default. Set SOCIAL_AUTO_PROVISION=false to
  // require a pre-existing local account.
  const raw = (process.env.SOCIAL_AUTO_PROVISION ?? "").trim().toLowerCase()
  return raw !== "false" && raw !== "0" && raw !== "no"
}

export const googleConfig = (): SocialProviderConfig | null => {
  const pair = readPair("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET")
  if (!pair) return null
  return {
    provider: "google",
    client_id: pair.id,
    client_secret: pair.secret,
    label: "Sign in with Google",
    auto_provision: autoProvision(),
  }
}

export const githubConfig = (): SocialProviderConfig | null => {
  const pair = readPair("GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET")
  if (!pair) return null
  return {
    provider: "github",
    client_id: pair.id,
    client_secret: pair.secret,
    label: "Sign in with GitHub",
    auto_provision: autoProvision(),
  }
}

export const configFor = (provider: SocialProvider): SocialProviderConfig | null =>
  provider === "google" ? googleConfig() : githubConfig()

export const enabledProviders = (): SocialProviderConfig[] =>
  [googleConfig(), githubConfig()].filter((c): c is SocialProviderConfig => c !== null)
