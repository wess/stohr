import { layout } from "./layout.ts"

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

export const accountDeletionEmail = (input: { name?: string | null; cancelUrl: string }) => {
  const greeting = input.name?.trim() || "there"
  const subject = "Your Stohr account is scheduled for deletion"

  const text = [
    `Hi ${greeting},`,
    "",
    "Your Stohr account is scheduled for permanent deletion in 24 hours. After that window, every file, folder, share, and version is unrecoverable.",
    "",
    "If this wasn't you, click the link below to cancel deletion immediately:",
    "",
    input.cancelUrl,
    "",
    "If you intended to delete the account, you can ignore this email — the account will be removed automatically.",
    "",
    "— Stohr",
  ].join("\n")

  const safeName = escapeHtml(greeting)
  const safeUrl = escapeHtml(input.cancelUrl)

  const body = `
    <p>Hi ${safeName},</p>
    <p>Your Stohr account is scheduled for permanent deletion in <strong>24 hours</strong>. After that window, every file, folder, share, and version is unrecoverable.</p>
    <p style="margin: 24px 0;">
      <a href="${safeUrl}" class="btn">Cancel deletion</a>
    </p>
    <p style="font-size: 13px; color: #4C566A;">Or paste this URL into your browser:<br>
      <a href="${safeUrl}" style="color: #5E81AC; word-break: break-all;">${safeUrl}</a>
    </p>
    <p style="font-size: 13px; color: #4C566A;">If you intended to delete the account, you can ignore this email — the account will be removed automatically.</p>
  `
  return { subject, html: layout({ title: subject, body }), text }
}
