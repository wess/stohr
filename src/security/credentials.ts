import type { Connection } from "@atlas/db"

// call under the user's row lock in the credential-change transaction
export const revokeCredentials = async (db: Connection, userId: number): Promise<void> => {
  await db.execute({ text: "UPDATE users SET oauth_epoch = oauth_epoch + 1 WHERE id = $1", values: [userId] })
  await db.execute({ text: "DELETE FROM webauthn_challenges WHERE user_id = $1", values: [userId] })
  await db.execute({ text: "DELETE FROM apps WHERE user_id = $1", values: [userId] })
  await db.execute({ text: "DELETE FROM s3_access_keys WHERE user_id = $1", values: [userId] })
  await db.execute({
    text: "UPDATE oauth_refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL",
    values: [userId],
  })
  await db.execute({ text: "DELETE FROM oauth_authorization_codes WHERE user_id = $1", values: [userId] })
  await db.execute({ text: "DELETE FROM oauth_device_codes WHERE user_id = $1", values: [userId] })
  await db.execute({
    text: "UPDATE password_resets SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL",
    values: [userId],
  })
}
