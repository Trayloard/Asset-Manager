---
name: Sessions are not FK-linked to users
description: Deleting a user does NOT remove or invalidate their sessions; account/data deletion must clean sessions explicitly.
---

The `sessions` table stores the authenticated user inside the `sess` JSONB column
(`sess->'user'->>'id'`) and has **no foreign key** to `usersTable`. Conversations and
messages DO cascade (users → conversations → messages, all `onDelete: cascade`), but
sessions do not.

**Why:** A deleted user's sessions otherwise survive. Because auth middleware populates
`req.user` from the session JSON, a stale session would keep `req.isAuthenticated()`
true for a user that no longer exists — letting a deleted account keep calling the API
(and hitting FK errors / empty data on writes).

**How to apply:** Any account-deletion or user-cleanup path must explicitly delete the
user's sessions, e.g. `delete from sessions where sess->'user'->>'id' = <userId>`, in
the same transaction as the user-row delete. The DB uses `drizzle-orm/node-postgres`
with a `Pool`, so multi-statement `db.transaction()` is supported (unlike neon-http).
