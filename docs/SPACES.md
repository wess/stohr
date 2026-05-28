# Spaces

A **Space** is a shared workspace: a folder tree co-owned by multiple users, with its own membership and permissions. Spaces complement (don't replace) the per-user **My Files** drive.

## Mental model

| | My Files | Space |
|---|---|---|
| Owned by | One user | The Space (with an admin owner) |
| Access | The user + per-folder collaborators | Space members |
| Roles | owner / editor / viewer (per share) | admin / editor / viewer (per space) |
| When to use | Personal documents, photos, archives | Team projects, departments, joint workstreams |

## Roles

| Space role | Maps to internal role | Can |
|---|---|---|
| `admin` | `owner` | Everything (manage members, edit settings, delete the space) |
| `editor` | `editor` | Create, edit, upload, share files; **cannot** manage members |
| `viewer` | `viewer` | Read + comment only |

The user who creates a space is automatically an `admin` member and the space's `owner_id`. Ownership can be transferred (PATCH the space) but the owner row always has the `admin` role.

## Creating + managing

From the **Spaces** tab in the SPA:

- Click **New space** → give it a name (slug auto-generated from the name).
- On the space page, the **Members** tab adds/removes/role-changes other users.
- The **Folders** tab is the team root — folders created here belong to the Space, not to whoever created them.

REST equivalents live under `/spaces/*`:

```
POST   /spaces                       create
GET    /spaces                       list (my memberships)
GET    /spaces/:id                   detail (404 for non-members)
PATCH  /spaces/:id                   rename / re-describe (admin only)
DELETE /spaces/:id                   soft-delete the space + its folders (owner only)

GET    /spaces/:id/members           list members
POST   /spaces/:id/members           add by username/email (admin only)
PATCH  /spaces/:id/members/:mid      change role (admin only; cannot demote owner)
DELETE /spaces/:id/members/:mid      remove (admin) or leave (self)

GET    /spaces/:id/folders           top-level folders
POST   /spaces/:id/folders           create top-level folder (editor+)
```

Folders inside a Space behave like regular folders for upload, rename, share, comment, etc. — the only difference is that access is resolved through `space_members` rather than the personal-drive ownership + collaboration tables.

## Permissions model

Every folder and file carries an optional `space_id`. When non-null, the permissions resolver consults `space_members` and returns:

- `admin` → treated as `owner`
- `editor` → `editor`
- `viewer` → `viewer`

The folder's `user_id` is the *creator* (used for attribution, audit, and storage-key prefixing) — it does **not** grant access. Likewise the file's `user_id` doesn't grant access inside a Space; only membership does.

## Soft-delete

Deleting a space is owner-only. It sets `spaces.deleted_at` and cascades a `deleted_at` to every folder pinned to the space. Files inside those folders inherit the `deleted_at` of their folder for listing purposes (you'll see them in the owner's `/trash` until a future hard-delete sweep purges them).
