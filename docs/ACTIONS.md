# Action folders

An **Action folder** is a regular folder with one or more **actions** attached. When something happens inside that folder (a file is uploaded, moved in, renamed, deleted, etc.) the matching actions run automatically — resize the image, organize by date, route to another folder, whatever the action implements.

Actions are addressable by a global slug (`<author>/<name>`, e.g. `stohr/resize-image`). The presence of any `folder_actions` row for a folder makes that folder an action folder; there is no separate `kind`.

## Events

Direct-children only — actions on `/photos` see things that happen *to* `/photos` and to files/folders one level deep inside it, not into deeper subtrees.

| Event | Fires when |
| --- | --- |
| `file.created` | file uploaded directly into this folder |
| `file.updated` | file in this folder renamed or re-uploaded (new version) |
| `file.deleted` | file in this folder soft-deleted |
| `file.moved.in` | file moved here from another folder |
| `file.moved.out` | file moved from here to another folder |
| `folder.created` | subfolder created directly under this folder |
| `folder.updated` | direct subfolder renamed |
| `folder.deleted` | direct subfolder soft-deleted |
| `folder.moved.in` | folder moved here |
| `folder.moved.out` | folder moved out |

`purge`, `restore`, and version-restore intentionally do **not** fire events.

## Execution model (v1)

Actions run **synchronously**, in `created_at ASC` order, with a 30-second per-action timeout. The parent request blocks until all actions complete or fail.

Failures are logged to `folder_action_runs` and surfaced in the response body but never fail the parent operation — actions are reactive, not blocking. An action that throws or returns `{ ok: false }` shows up in the next `GET /folders/:id/actions/runs` call.

Actions run with the **folder owner's** identity for storage / quota purposes, regardless of who triggered the event.

A **depth-1 cascade cap** prevents loops: an action can trigger one level of follow-on events (e.g. a move into a subfolder may fire `file.moved.in` once), but the cascade stops there.

## Writing a built-in action

Actions live under `src/actions/<author>/<name>.ts` and export a default `Action`. Built-ins ship under the `stohr/` author namespace.

```ts
import type { Action } from "../types.ts"

const myAction: Action = {
  slug: "stohr/my-action",            // <author>/<name>, lowercase
  name: "Human-readable name",
  description: "What it does and when to reach for it.",
  version: "1.0.0",
  author: { name: "Stohr", url: "https://stohr.io" },
  permissions: ["file.read", "file.write"],
  events: ["file.created", "file.moved.in"],
  subjects: ["file"],
  configSchema: {
    type: "object",
    required: ["target"],
    properties: {
      target: { type: "string", title: "Target name" },
    },
  },
  run: async (ctx) => {
    if (ctx.subject.kind !== "file") return { ok: false, error: "Not a file" }
    // do work…
    return { ok: true, result: { handled: ctx.subject.row.id } }
  },
}

export default myAction
```

Then register it in `src/actions/registry.ts`:

```ts
import myAction from "./stohr/my-action.ts"
register(myAction)
```

That's it. Adding a route, schema migration, or UI is not required — the registry exposes the action through `GET /actions/registry` and the SPA renders the config form from `configSchema`.

### `ActionContext`

| Field | Description |
| --- | --- |
| `db` | The Postgres connection — query / mutate any table |
| `store` | Storage handle — `put`, `fetchObject`, `drop`, `makeKey` from `src/storage/index.ts` |
| `folder` | The action folder (full row) |
| `event` | The event that fired this run |
| `subject` | `{ kind: "file", row }` or `{ kind: "folder", row }` |
| `actor` | The user who *triggered* the event (may differ from the folder owner) |
| `ownerId` | The folder owner's id — use this for storage keys + quota |
| `config` | Parsed JSON config supplied when the action was attached |
| `depth` | Cascade depth; 0 for first-fire, 1 for follow-ons |

### Result

```ts
type ActionResult =
  | { ok: true; result?: Record<string, unknown> }    // returned to caller in action_results
  | { ok: false; error: string }                       // logged, doesn't fail the parent op
```

Anything you return in `result` is JSON-stringified into `folder_action_runs.result` and shown to the user.

### Permissions (declared, not enforced in v1)

Built-ins trust the host fully. The `permissions` array is metadata for future third-party action consent screens — declare honestly so the marketplace UI shows the right thing later.

## Permissions for managing actions

Configuring (create / edit / delete) a folder's actions requires **owner** role on the folder. Listing actions and runs is allowed for any role with read access.

Actions themselves run as the folder owner — file writes, quota usage, and storage keys all bill to the owner, not the user who triggered the event.

## API reference

```
GET    /actions/registry                  # public list of available actions
GET    /folders/:id/actions               # list actions on this folder
POST   /folders/:id/actions               # { event, slug, config, enabled? }
PATCH  /folders/:id/actions/:aid          # { event?, config?, enabled? }
DELETE /folders/:id/actions/:aid
GET    /folders/:id/actions/runs?limit=   # recent runs (default 50, max 200)
```

See [docs/API.md](API.md) for the full REST surface.

## Roadmap (deliberately not in v1)

- Sandboxing or out-of-process actions (wasm / v8 isolate / remote scripts)
- Permission **enforcement** at runtime (the field is metadata only today)
- Marketplace install/uninstall via remote registry
- Paid actions / per-action revenue share
- Async / queued execution + retry policies
- Recursion deeper than direct children
