import type { Connection } from "@atlas/db"
import type { StorageHandle } from "../storage/index.ts"
import { register, registerRecurring } from "./index.ts"
import { handleWebhookDelivery } from "../webhooks/deliver.ts"
import { handleTrashAutoPurge } from "../trash/autopurge.ts"

// One place to wire job types -> handlers. Server boot calls this once.

export const registerJobs = (store: StorageHandle): void => {
  register("webhook.deliver", async (db, payload) => {
    await handleWebhookDelivery(db, payload as { delivery_id: number })
  })

  // Hourly auto-purge sweep. Recurring jobs re-enqueue themselves on success.
  const oneHour = 60 * 60 * 1000
  registerRecurring("trash.autopurge", oneHour, async (db) => {
    await handleTrashAutoPurge(db, store)
  })
}
