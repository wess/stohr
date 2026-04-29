import { layout } from "./layout.ts"

export const inviteEmail = (input: {
  inviterName?: string | null
  email: string
  signupUrl: string
  /** Free-form note from the inviter, shown as a quote. Optional. */
  note?: string | null
}) => {
  const inviter = input.inviterName?.trim() || "Someone"
  const subject = `${inviter} invited you to Stohr`

  const text = [
    `${inviter} invited you to join Stohr — self-hostable cloud storage with photo galleries, sharing, and more.`,
    "",
    input.note ? `Their note:\n"${input.note}"\n` : "",
    "Sign up here (this invite is tied to your email):",
    input.signupUrl,
    "",
    "If you weren't expecting this, you can ignore the email.",
    "",
    "— Stohr",
  ].filter(line => line !== undefined).join("\n")

  const noteBlock = input.note
    ? `<blockquote style="border-left: 3px solid #5E81AC; padding: 4px 14px; color: #3B4252; margin: 16px 0; font-style: italic;">${escapeHtml(input.note)}</blockquote>`
    : ""

  const body = `
    <p><strong>${escapeHtml(inviter)}</strong> invited you to join Stohr — self-hostable cloud storage with photo galleries, sharing, and more.</p>
    ${noteBlock}
    <p style="margin: 24px 0;">
      <a href="${input.signupUrl}" class="btn">Accept invite</a>
    </p>
    <p style="font-size: 13px; color: #4C566A;">Or paste this URL into your browser:<br>
      <a href="${input.signupUrl}" style="color: #5E81AC; word-break: break-all;">${input.signupUrl}</a>
    </p>
    <p style="font-size: 13px; color: #4C566A;">If you weren't expecting this, you can ignore the email.</p>
  `
  return { subject, html: layout({ title: subject, body }), text }
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
