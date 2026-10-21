---
id: 202
title: Relayed mail content is plaintext at rest
blocked-by: []
---

# 202 — Relayed mail content is plaintext at rest

**Summary.** Control stores the whole request body of every relayed message, IAM's sign-in links included, as plain
text until the row is final. Encrypt it under the vault's key. P3, size M.

## Problem

`mail_messages.content` (`packages/control/migrations/0013_mail_relay.sql:32`, the same column in
`migrations-postgres/`) is the canonical request body: recipient, subject, bodies and attachments
(`packages/control/src/db/mail-messages.ts:32`). It stays until the row is final: the dispatcher purges an
`installation:*` message right after its final state (`packages/control/src/mail-relay/dispatch.ts:128`), and every
other message waits for `purgeFinalContent`. A queued or retrying IAM message holds a live reset, enrollment or
invitation link for as long as the relay retries it (hours).

The console no longer shows an `installation:*` message's content to anyone. A reader of Control's database (a
backup, a database credential, an operator with SQL access) still reads every link, which ADR-0019 §8 says nobody
sees.

## Approach / acceptance

Seal `content` with the vault's envelope (`packages/control/src/vault.ts`: AES-256-GCM, a data key wrapped by the
installation's KEK) at acceptance and open it only in the dispatcher and in `mailContentOf`. To decide: a new column
(`content_envelope`) or the envelope in `content` with a format marker, and whether a KEK rotation re-wraps these rows
as it re-wraps vault rows.

Migration on both dialects (`migrations/` and `migrations-postgres/`, per `packages/control/DATABASE.md`). Rollout on
an existing installation: rows accepted before the upgrade still hold plain text; the reader accepts both forms until
the last such row is final and purged, or the migration seals them in place. No environment variable changes: the KEK
is already Control's.

Witness: a repository test that the stored column holds no recipient, subject or body text, and a dispatcher test
that a sealed row sends the same message as before. Both dialects.

## Touch points

`packages/control/src/db/mail-messages.ts`, `packages/control/src/mail-relay/`, `packages/control/src/control-rpc.ts`
(`mailContentOf`), `packages/control/src/vault.ts`, `packages/control/migrations/`,
`packages/control/migrations-postgres/`, ADR-0019 §8.

<!-- Origin: a platform review; the console withholding installation mail content shipped first. -->
