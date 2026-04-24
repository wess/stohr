import { foreman } from "@atlas/cli"

await foreman({
  api: "bun --hot src/server.ts",
  web: "bun --hot src/web/serve.ts",
})
