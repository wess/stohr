import { layout } from "./layout.ts"

export const passwordResetEmail = (input: { name?: string | null; resetUrl: string }) => {
  const greeting = input.name?.trim() || "there"
  const subject = "Reset your Stohr password"
  const text = [
    `Hi ${greeting},`,
    "",
    "You (or someone using your email) asked to reset your Stohr password. Click the link below to set a new one:",
    "",
    input.resetUrl,
    "",
    "This link expires in one hour. If you didn't request this, you can ignore this email — your password won't change.",
    "",
    "— Stohr",
  ].join("\n")

  const body = `
    <p>Hi ${greeting},</p>
    <p>You (or someone using your email) asked to reset your Stohr password. Click the button below to set a new one.</p>
    <p style="margin: 24px 0;">
      <a href="${input.resetUrl}" class="btn">Reset password</a>
    </p>
    <p style="font-size: 13px; color: #4C566A;">Or paste this URL into your browser:<br>
      <a href="${input.resetUrl}" style="color: #5E81AC; word-break: break-all;">${input.resetUrl}</a>
    </p>
    <p style="font-size: 13px; color: #4C566A;">This link expires in one hour. If you didn't request this, you can ignore this email — your password won't change.</p>
  `
  return { subject, html: layout({ title: subject, body }), text }
}
