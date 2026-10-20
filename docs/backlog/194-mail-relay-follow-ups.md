---
id: 194
title: Mail relay follow-ups
blocked-by: []
---

# 194 — Mail relay follow-ups

**Summary.** Gaps the review of the platform transport and the mail relay found and did not block on
([ADR-0064](../decisions/0064-applications-reach-the-platform-over-a-receiver-verified-transport-key.md),
[ADR-0019](../decisions/0019-portable-outbound-email.md) §8). Two can send a message twice over a provider without
idempotency; the rest are small.

## Problem

### The dispatcher can send a message twice

1. **No claim before the send.** `dispatchMail` (`packages/control/src/mail-relay/dispatch.ts`) sends first and then
   writes `sent` and `attempts`. When the process crashes, or the database write fails, after the provider took the
   message, the job is delivered again and sends again, and no attempt was counted. Over a provider without
   idempotency (SmartEmailing) the recipient gets two messages.
2. **Two jobs for one message both send.** A message can have more than one dispatch job: maintenance re-enqueues a
   stale `queued` row, a release enqueues, a retry enqueues a delayed job. Two consumers can pick two jobs of one
   message and both send. A `markSent` that answers `false` after a send is not logged.

**Fix for both:** claim before the send. A guarded update raises `attempts` (and sets a claim time) only on a `queued`,
due row whose `attempts` is still the value read; a job that loses the claim does nothing. A job that finds a claimed
row it did not settle (a crash after the claim) settles it as `unknown` when the transport is not idempotent, and
sends again only when it is. Log a `markSent` that answers `false`.

### The dispatcher and maintenance

3. **Maintenance re-enqueues the same rows on every run while the consumer is behind.** `listDueQueued` selects by
   `updated_at`, and an enqueue does not bump it, so the jobs grow without bound. Bump `updated_at` on re-enqueue, or
   select by a separate enqueue time.
4. **A failed purge keeps IAM's link for 30 days.** The dispatcher purges an installation message's content right
   after its final state; when that write fails, the content waits for the 30-day purge. Maintenance should purge a
   final `installation:*` row at any age.
5. **A failed enqueue at acceptance waits up to 10 minutes.** The row is `queued` and the sender's retry finds the
   existing row and enqueues nothing; maintenance re-enqueues it after `MAIL_STALE_QUEUED_S`.
6. **The relay accepts attachments the installation's transport cannot send.** It checks against
   `PLATFORM_MAIL_CAPABILITIES` (10 MiB), not against Control's transport. Over SmartEmailing, which sends no
   attachments, the message is accepted and then fails `invalid_message` at dispatch.
7. **IAM's key is derived on every request.** `authenticate` computes `installationMailKey` per request; compute it
   once at boot.

### The console

8. **The held list hides an outage.** `packages/dashboard/src/routes/mail/index.tsx` turns every error of the held
   list into an empty list, so an outage reads as "no held mail". Show the refusal.
9. **A release whose enqueue fails answers 500.** `releaseMailMessage` moves the row to `queued` and then enqueues; a
   failed enqueue answers 500 although the message is released (maintenance re-enqueues it). Catch it there: the row
   is the source of truth. Add a test with a throwing `mailQueue.send`.
10. **Links in the HTML preview navigate.** The sandboxed frame runs no script, but a click still loads the link
    inside it, which tells a tracker the operator's address. Add `<base target="_blank">`.
11. **Small authorization and ordering edges.** A caller with `mail.manage` and without `mail.read` gets a message's
    metadata in the answer of a release or a drop. On the Worker a release answers 503 before it checks that the
    message exists (404).
12. **The detail decodes every attachment to read its size**, and **the held section stops at 50** with no pager.
13. **`rules.set` checks that the environment exists, then upserts**, not atomically: a rule can name an environment
    deleted in between.

### The sender and the wire

14. **A non-JSON error answer is `malformed_response`.** `PlatformEmailSender` reads a 401, 404 or 502 without a JSON
    body as `malformed_response` (retryable, `unknown`). Map 401 to `provider_unauthorized` and 502–504 to
    `provider_unavailable`.
15. **The body is encoded twice.** `PlatformEmailSender.send` parses the canonical text and `postToProvider`
    serializes it again. Let `postToProvider` take a body that is already text.
16. **A registry provider named `platform` is shadowed.** `ctx.mail` reads `FABRIKA_EMAIL_PROVIDER=platform` before
    the registry, so an application provider of that name can never be selected. Refuse the name in a registry, or
    say so where a registry is built.

### Keys

17. **Expired keys of other environments leave their vault values.** `VaultPlatformTransport.reconcile` deletes every
    expired key row of the installation (`deleteExpired`) but only its own environment's vault values. Delete expired
    rows per environment (`deleteExpiredForAppEnv`, returning their refs) and delete their vault values. Not a
    security gap: the hash rows are gone, so the values authenticate nothing.

### The older releases

18. **The console does not say which environments the gate covers.** An application on a release older than 0.7
    still sends directly. The Mail page shows only relayed messages and does not list the environments outside the
    gate.

### IAM over the relay

19. **IAM learns nothing of a final failure.** The relay answers `accepted` and IAM reports the invitation as sent;
    when the dispatcher later ends the message `failed` or `unknown`, IAM does not offer the manual link. Only Control's
    Mail page shows it.

### Tests

20. Missing cases: a key of another receiver; the body cap on a chunked body; duplicate and concurrent dispatch jobs;
    `runMaintenance`'s mail summary; an application-scoped `mail.content.read` that reads `withheld`; an environment
    grant that reads another environment (403); a non-ASCII key; an error body under 200; an acceptance with an empty
    `messageId`. `mail.test.ts`'s `<script>` check is trivial.

## Approach / acceptance

Items 1 and 2 first, with one test that crashes after the provider accepted and one that runs two jobs of one message,
each over a `MemoryEmailSender` with `idempotent: false`: the recipient gets one message, and the row ends `sent` or
`unknown`. The rest are independent and small.

## Touch points

`packages/control/src/mail-relay/`, `packages/control/src/db/mail-messages.ts`, `packages/control/src/control-rpc.ts`,
`packages/control/src/platform-transport.ts`, `packages/control/src/db/platform-transport-keys.ts`,
`packages/dashboard/src/routes/mail/`, `packages/email/src/{platform,http}.ts`, `packages/app/src/jobs/mail.ts`, and
their tests.

<!-- Origin: the review of sprint-2026-10-20-platform-transport-mail-relay (WU-1 to WU-5). -->
