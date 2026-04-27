export type CloudinitInput = {
  githubRepo: string
  branch: string
  githubToken?: string
  postgresPassword: string
  secret: string
  s3Endpoint: string
  s3Bucket: string
  s3Region: string
  s3AccessKey: string
  s3SecretKey: string
  domain: string | null
}

const b64 = (s: string) => Buffer.from(s).toString("base64")

export const generateCloudInit = (input: CloudinitInput): string => {
  const envFile = [
    `POSTGRES_PASSWORD=${input.postgresPassword}`,
    `SECRET=${input.secret}`,
    `S3_ENDPOINT=${input.s3Endpoint}`,
    `S3_BUCKET=${input.s3Bucket}`,
    `S3_REGION=${input.s3Region}`,
    `S3_ACCESS_KEY=${input.s3AccessKey}`,
    `S3_SECRET_KEY=${input.s3SecretKey}`,
  ].join("\n") + "\n"

  const caddyfile = input.domain
    ? `${input.domain} {\n\treverse_proxy web:3001\n}\n`
    : `:80 {\n\treverse_proxy web:3001\n}\n`

  const cloneUrl = input.githubToken
    ? `https://${input.githubToken}@github.com/${input.githubRepo}.git`
    : `https://github.com/${input.githubRepo}.git`

  const bootstrap = `#!/bin/bash
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive

curl -fsSL https://get.docker.com | sh
systemctl enable --now docker

mkdir -p /opt
cd /opt
if [ ! -d stohr ]; then
  git clone --recurse-submodules --branch ${input.branch} ${cloneUrl} stohr
fi
cd /opt/stohr

cp /etc/stohr/.env .env
cp /etc/stohr/caddyfile caddyfile

docker compose up -d --build
`

  return `#cloud-config
package_update: true
packages:
  - git
  - ca-certificates
  - curl
write_files:
  - path: /etc/stohr/.env
    permissions: '0600'
    encoding: b64
    content: ${b64(envFile)}
  - path: /etc/stohr/caddyfile
    permissions: '0644'
    encoding: b64
    content: ${b64(caddyfile)}
  - path: /etc/stohr/bootstrap.sh
    permissions: '0755'
    encoding: b64
    content: ${b64(bootstrap)}
runcmd:
  - bash /etc/stohr/bootstrap.sh > /var/log/stohr-bootstrap.log 2>&1 || true
`
}
