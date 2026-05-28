# Messaging

Stohr has a built-in mailbox: every user has an inbox + sent + archived view, and the system can deliver messages to users for events like account suspension, password reset, or owner announcements.

## Kinds

- `user` — sent by another user. The recipient can reply; both parties see the thread.
- `system` — sent by Stohr itself (signup welcome, suspended/restored, owner broadcast). `from` is `null`. The recipient can read, archive, or delete but **cannot reply** — there's no other end.

## Threading

The first message in a conversation has `thread_id = id`. Replies inherit the parent's `thread_id` and link `parent_id` to the message they reply to. The thread view returns every non-deleted message in chronological order, scoped to participants.

## Routes

All under `/me/messages/*`, authenticated:

```
GET   /me/messages?box=inbox|sent|archived   list (default inbox)
GET   /me/messages/unread-count              { unread: N }
GET   /me/messages/thread/:threadId          full thread (auto-marks-read your copies)
POST  /me/messages                           send to user — { username|email, subject, body }
POST  /me/messages/:id/reply                 reply — { body } (re: subject inherited)
POST  /me/messages/:id/read                  mark a single message read
POST  /me/messages/read-all                  mark every inbox message read
POST  /me/messages/:id/archive
POST  /me/messages/:id/unarchive
DELETE /me/messages/:id                      soft-delete (from your side)
```

## System messages

Owners can send messages from the admin panel:

- **Admin → Users → Message** sends to a single user.
- **Admin → Users → Broadcast** sends to every active user (one row per recipient).
- Suspending or restoring a user automatically delivers a system message with the reason.

The internal helper `sendSystem(db, userId, subject, body)` from `src/messages/system.ts` is what every other module calls when it wants to drop something into a user's inbox.

## Notifications

Each new message also emits a notification of kind `comment.created` (or `comment.reply`) so the **Notifications** bell in the sidebar shows an unread badge. Open the message to mark it read; clearing notifications and clearing message-unread are independent.

## Limits

- Subject ≤ 200 chars
- Body ≤ 50 000 chars
- Up to 200 messages per inbox query (paginate if you need more)

## What's not (yet) supported

- Attachments (link to files via URL for now)
- Read receipts for system-sent broadcasts
- Group threads with > 2 participants (use a Space + comments instead)
