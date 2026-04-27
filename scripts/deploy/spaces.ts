import type { ApiClient } from "./api.ts"
import { signRequest } from "./sigv4.ts"

export type SpacesKey = {
  name: string
  access_key: string
  secret_key: string
}

export const createSpacesKey = async (
  api: ApiClient,
  name: string,
  bucket: string,
): Promise<SpacesKey> => {
  const res = await api.request<{ key: SpacesKey }>("POST", "/spaces/keys", {
    name,
    grants: [{ bucket, permission: "fullaccess" }],
  })
  if (!res.key?.access_key || !res.key?.secret_key) {
    throw new Error(
      "Spaces key API did not return credentials. Create the key manually in the dashboard and pass S3_ACCESS_KEY / S3_SECRET_KEY as env vars.",
    )
  }
  return res.key
}

export const createBucket = async (
  region: string,
  accessKey: string,
  secretKey: string,
  bucket: string,
): Promise<{ created: boolean }> => {
  const host = `${region}.digitaloceanspaces.com`
  const path = `/${bucket}`
  const headers = signRequest({
    method: "PUT",
    host,
    path,
    region,
    service: "s3",
    accessKey,
    secretKey,
    payload: "",
    extraHeaders: { "x-amz-acl": "private" },
  })

  const res = await fetch(`https://${host}${path}`, { method: "PUT", headers })
  if (res.ok) return { created: true }

  const body = await res.text()
  if (res.status === 409 || body.includes("BucketAlreadyOwnedByYou")) {
    return { created: false }
  }
  throw new Error(`Bucket creation failed: ${res.status} ${body}`)
}
