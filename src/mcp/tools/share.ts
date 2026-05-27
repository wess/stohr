import { hash } from "@atlas/auth"
import { from, raw } from "@atlas/db"
import { asError, asText, type Tool, type ToolContext } from "./index.ts"

const MAX_EXPIRES_SECONDS = 30 * 24 * 60 * 60
const SHORT_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
const SHORT_LEN = 7

const shortToken = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(SHORT_LEN))
  let out = ""
  for (let i = 0; i < SHORT_LEN; i++) {
    out += SHORT_ALPHABET[bytes[i]! % SHORT_ALPHABET.length]
  }
  return out
}

const allocToken = async (ctx: ToolContext): Promise<string> => {
  for (let i = 0; i < 8; i++) {
    const candidate = shortToken()
    const taken = await ctx.db.one(
      from("shares").where(q => q("token").equals(candidate)).select("id"),
    )
    if (!taken) return candidate
  }
  throw new Error("Could not allocate a unique share token")
}

const listShares = async (ctx: ToolContext) => {
  const rows = await ctx.db.all(
    from("shares")
      .join("files", raw("files.id = shares.file_id"))
      .where(q => q("shares.user_id").equals(ctx.userId))
      .where(q => q("files.deleted_at").isNull())
      .select(
        "shares.id", "shares.token", "shares.expires_at", "shares.created_at",
        "shares.burn_on_view", "shares.password_hash",
        "files.name", "files.size", "files.mime", "shares.file_id",
      )
      .orderBy("shares.created_at", "DESC")
  )
  return asText(rows.map((r: any) => ({
    id: r.id,
    token: r.token,
    url: `${ctx.appUrl}/s/${r.token}`,
    expires_at: r.expires_at,
    created_at: r.created_at,
    burn_on_view: r.burn_on_view,
    password_required: !!r.password_hash,
    file: { id: r.file_id, name: r.name, size: r.size, mime: r.mime },
  })))
}

const createShare = async (ctx: ToolContext, args: Record<string, unknown>) => {
  const fileId = Number(args.file_id ?? args.fileId)
  if (!Number.isFinite(fileId)) return asError("file_id is required")
  const expiresIn = Number(args.expires_in ?? args.expiresIn ?? 0)
  if (!expiresIn || expiresIn <= 0) return asError("expires_in is required and must be > 0 seconds")
  if (expiresIn > MAX_EXPIRES_SECONDS) {
    return asError(`expires_in cannot exceed ${MAX_EXPIRES_SECONDS} seconds (30 days)`)
  }
  const burnOnView = Boolean(args.burn_on_view ?? args.burnOnView ?? false)
  const password = typeof args.password === "string" && args.password.trim() ? args.password.trim() : null

  const file = await ctx.db.one(
    from("files")
      .where(q => q("id").equals(fileId))
      .where(q => q("user_id").equals(ctx.userId))
      .where(q => q("deleted_at").isNull()),
  )
  if (!file) return asError("File not found")

  const tok = await allocToken(ctx)
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString()
  const passwordHash = password ? await hash(password) : null

  const rows = await ctx.db.execute(
    from("shares")
      .insert({
        file_id: fileId,
        user_id: ctx.userId,
        token: tok,
        expires_at: expiresAt,
        password_hash: passwordHash,
        burn_on_view: burnOnView,
      })
      .returning("id", "token", "expires_at", "burn_on_view", "created_at"),
  ) as Array<{ id: number; token: string; expires_at: string; burn_on_view: boolean; created_at: string }>

  const out = rows[0]!
  return asText({
    ...out,
    url: `${ctx.appUrl}/s/${out.token}`,
    password_required: !!passwordHash,
  })
}

const revokeShare = async (ctx: ToolContext, args: Record<string, unknown>) => {
  const id = Number(args.id ?? args.share_id ?? args.shareId)
  if (!Number.isFinite(id)) return asError("id is required")
  const row = await ctx.db.one(
    from("shares").where(q => q("id").equals(id)).where(q => q("user_id").equals(ctx.userId)),
  )
  if (!row) return asError("Share not found")
  await ctx.db.execute(from("shares").where(q => q("id").equals(id)).del())
  return asText({ id, revoked: true })
}

export const shareTools = (): Tool[] => [
  {
    name: "list_shares",
    description: "List the caller's active share links with the public URL for each.",
    category: "share",
    inputSchema: { type: "object", properties: {} },
    handler: (ctx) => listShares(ctx),
  },
  {
    name: "create_share",
    description: "Create a public share link for a file the caller owns. expires_in is in seconds; max 30 days.",
    category: "share",
    inputSchema: {
      type: "object",
      properties: {
        file_id: { type: "integer" },
        expires_in: { type: "integer", description: "Seconds until expiry. Max 2592000 (30 days)." },
        password: { type: "string", description: "Optional password the recipient must enter." },
        burn_on_view: { type: "boolean", description: "Delete the share after the first download." },
      },
      required: ["file_id", "expires_in"],
    },
    handler: createShare,
  },
  {
    name: "revoke_share",
    description: "Revoke (delete) one of the caller's share links by id.",
    category: "share",
    inputSchema: {
      type: "object",
      properties: { id: { type: "integer" } },
      required: ["id"],
    },
    handler: revokeShare,
  },
]
