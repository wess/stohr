import { column, defineSchema } from "@atlas/db"

export const users = defineSchema("users", {
  id: column.serial().primaryKey(),
  email: column.text().unique(),
  name: column.text(),
  password: column.text(),
  created_at: column.timestamp().default("now()"),
})

export const folders = defineSchema("folders", {
  id: column.serial().primaryKey(),
  user_id: column.integer().ref("users", "id"),
  parent_id: column.integer().nullable().ref("folders", "id"),
  name: column.text(),
  deleted_at: column.timestamp().nullable(),
  created_at: column.timestamp().default("now()"),
})

export const files = defineSchema("files", {
  id: column.serial().primaryKey(),
  user_id: column.integer().ref("users", "id"),
  folder_id: column.integer().nullable().ref("folders", "id"),
  name: column.text(),
  mime: column.text(),
  size: column.bigint(),
  storage_key: column.text(),
  thumb_key: column.text().nullable(),
  version: column.integer().default(1),
  deleted_at: column.timestamp().nullable(),
  created_at: column.timestamp().default("now()"),
})

export const fileVersions = defineSchema("file_versions", {
  id: column.serial().primaryKey(),
  file_id: column.integer().ref("files", "id"),
  version: column.integer(),
  mime: column.text(),
  size: column.bigint(),
  storage_key: column.text(),
  uploaded_by: column.integer().nullable().ref("users", "id"),
  uploaded_at: column.timestamp().default("now()"),
})

export const shares = defineSchema("shares", {
  id: column.serial().primaryKey(),
  file_id: column.integer().ref("files", "id"),
  user_id: column.integer().ref("users", "id"),
  token: column.text().unique(),
  expires_at: column.timestamp().nullable(),
  created_at: column.timestamp().default("now()"),
})
