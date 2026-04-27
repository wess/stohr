import { createHash, createHmac } from "node:crypto"

const sha256hex = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex")

const hmac = (key: string | Buffer, data: string) =>
  createHmac("sha256", key).update(data).digest()

export type SignInput = {
  method: string
  host: string
  path: string
  region: string
  service: string
  accessKey: string
  secretKey: string
  payload?: string
  extraHeaders?: Record<string, string>
}

export const signRequest = (opts: SignInput): Record<string, string> => {
  const now = new Date()
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "")
  const dateStamp = amzDate.slice(0, 8)
  const payload = opts.payload ?? ""
  const payloadHash = sha256hex(payload)

  const headers: Record<string, string> = {
    host: opts.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    ...(opts.extraHeaders ?? {}),
  }

  const sortedKeys = Object.keys(headers).map(k => k.toLowerCase()).sort()
  const canonicalHeaders = sortedKeys.map(k => `${k}:${(headers[k] ?? "").trim()}\n`).join("")
  const signedHeaders = sortedKeys.join(";")

  const canonicalRequest = [
    opts.method,
    opts.path,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n")

  const credentialScope = `${dateStamp}/${opts.region}/${opts.service}/aws4_request`
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256hex(canonicalRequest),
  ].join("\n")

  const kDate = hmac(`AWS4${opts.secretKey}`, dateStamp)
  const kRegion = hmac(kDate, opts.region)
  const kService = hmac(kRegion, opts.service)
  const kSigning = hmac(kService, "aws4_request")
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex")

  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${opts.accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  }
}
