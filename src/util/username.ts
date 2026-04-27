const USERNAME_RE = /^[a-z0-9_]{3,32}$/

export const normalizeUsername = (raw: string) => raw.trim().toLowerCase()

export const isValidUsername = (raw: string) => USERNAME_RE.test(raw)

export const isEmail = (raw: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)
