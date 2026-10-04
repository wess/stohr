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

// Containers must not reach the droplet's metadata endpoint — it hands out
// the instance's user-data, which is this very cloud-init with every secret
// in it. DOCKER-USER is the chain docker leaves for operator rules; the unit
// re-applies the rule after every docker restart and is idempotent.
const METADATA_IP = "169.254.169.254"
const metadataGuardUnit = `[Unit]
Description=Block container access to the cloud metadata endpoint
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh -c 'iptables -C DOCKER-USER -d ${METADATA_IP} -j DROP 2>/dev/null || iptables -I DOCKER-USER -d ${METADATA_IP} -j DROP'

[Install]
WantedBy=multi-user.target
`

export const generateCloudInit = (input: CloudinitInput): string => {
  const envFile = `${[
    `POSTGRES_PASSWORD=${input.postgresPassword}`,
    `SECRET=${input.secret}`,
    `S3_ENDPOINT=${input.s3Endpoint}`,
    `S3_BUCKET=${input.s3Bucket}`,
    `S3_REGION=${input.s3Region}`,
    `S3_ACCESS_KEY=${input.s3AccessKey}`,
    `S3_SECRET_KEY=${input.s3SecretKey}`,
  ].join("\n")}\n`

  const caddyfile = input.domain
    ? `${input.domain} {\n\treverse_proxy web:3001\n}\n`
    : `:80 {\n\treverse_proxy web:3001\n}\n`

  // the token lives in a 0600 credentials file read by git's store helper,
  // never in the clone URL where it would land in .git/config and the log
  const gitCredentials = input.githubToken ? `https://x-access-token:${input.githubToken}@github.com\n` : null

  const bootstrap = `#!/bin/bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

curl -fsSL https://get.docker.com | sh
systemctl enable --now docker

systemctl daemon-reload
systemctl enable --now stohr-metadata-guard.service

${gitCredentials ? "git config --global credential.helper store\n" : ""}mkdir -p /opt
cd /opt
if [ ! -d stohr ]; then
  git clone --recurse-submodules --branch ${input.branch} https://github.com/${input.githubRepo}.git stohr
fi
cd /opt/stohr

cp /etc/stohr/.env .env
cp /etc/stohr/caddyfile caddyfile

docker compose up -d --build
`

  const credentialFile = gitCredentials
    ? `  - path: /root/.git-credentials
    permissions: '0600'
    encoding: b64
    content: ${b64(gitCredentials)}
`
    : ""

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
  - path: /etc/systemd/system/stohr-metadata-guard.service
    permissions: '0644'
    encoding: b64
    content: ${b64(metadataGuardUnit)}
${credentialFile}  - path: /etc/stohr/bootstrap.sh
    permissions: '0700'
    encoding: b64
    content: ${b64(bootstrap)}
runcmd:
  - bash /etc/stohr/bootstrap.sh > /var/log/stohr-bootstrap.log 2>&1 || true
`
}
