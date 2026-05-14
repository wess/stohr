import { foreman } from "@atlas/cli"

// Production entry point — runs the API and the SPA-serving web proxy as a
// single process group. `src/dev.ts` is the `--hot` equivalent for local
// work. This is the Docker image's default CMD; compose.yaml and
// .do/app.yaml instead run the two processes as separate containers.
await foreman({
  api: "bun src/server.ts",
  web: "bun src/web/serve.ts",
})
