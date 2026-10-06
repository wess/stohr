import type { Connection } from "@atlas/db"
import { verifyTotpStep } from "./totp.ts"

export const claimTotp = async (db: Connection, userId: number, secret: string, code: string): Promise<boolean> => {
  const step = verifyTotpStep(secret, code)
  if (step === null) return false
  const rows = (await db.execute({
    text: `UPDATE users SET totp_last_step = $3
            WHERE id = $1 AND totp_secret = $2
              AND (totp_last_step IS NULL OR totp_last_step < $3)
            RETURNING id`,
    values: [userId, secret, step],
  })) as Array<{ id: number }>
  return rows.length === 1
}
