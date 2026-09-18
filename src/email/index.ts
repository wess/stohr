/* Tiny email layer over Resend's REST API. `apiUrl` points it at any server
 * that speaks that API instead of api.resend.com, e.g. a Corsair install at
 * https://<host>/api. If RESEND_API_KEY is unset, emails fall through to
 * console.log so dev still works without configuring a sending domain. */

export type EmailMessage = {
  to: string | string[]
  subject: string
  html: string
  text?: string
  replyTo?: string
}

export type EmailResult = { ok: true; id?: string; logged?: boolean } | { ok: false; error: string }

export type Emailer = {
  enabled: boolean
  send: (msg: EmailMessage) => Promise<EmailResult>
}

export const RESEND_API_URL = "https://api.resend.com"

export const createEmailer = (config: { apiKey: string; from: string; apiUrl?: string }): Emailer => {
  const apiKey = (config.apiKey ?? "").trim()
  const from = (config.from ?? "").trim()
  const enabled = apiKey.length > 0 && from.length > 0
  const endpoint = `${((config.apiUrl ?? "").trim() || RESEND_API_URL).replace(/\/+$/, "")}/emails`

  return {
    enabled,
    async send(msg) {
      const recipients = Array.isArray(msg.to) ? msg.to : [msg.to]
      if (!enabled) {
        console.log("[email] (RESEND_API_KEY not set — printing instead of sending)")
        console.log(`  to: ${recipients.join(", ")}`)
        console.log(`  subject: ${msg.subject}`)
        if (msg.text) console.log(msg.text)
        else console.log(msg.html)
        return { ok: true, logged: true }
      }
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            from,
            to: recipients,
            subject: msg.subject,
            html: msg.html,
            text: msg.text,
            reply_to: msg.replyTo,
          }),
        })
        if (!res.ok) {
          const body = await res.text().catch(() => "")
          return { ok: false, error: `${new URL(endpoint).host} ${res.status}: ${body.slice(0, 240)}` }
        }
        const data = (await res.json().catch(() => ({}))) as { id?: string }
        return { ok: true, id: data.id }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    },
  }
}
