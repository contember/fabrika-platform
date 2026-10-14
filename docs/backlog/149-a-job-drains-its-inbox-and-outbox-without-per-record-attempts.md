---
id: 149
title: A job drains its inbox and outbox without per-record attempts
blocked-by: []
---

# 149 — A job drains its inbox and outbox without per-record attempts

**Summary.** The skill's intake job drains an inbox in one unbounded transaction and sends its e-mails in one run, so
one bad row or one refused recipient stops the batch, and the e-mail has no idempotency key. Every application that
follows the recipe inherits this. Effort: M; no workflow engine.

## Problem

In `packages/app/skill/references/public-intake.md`:

- `delete from registrations returning …` (`:397`) has no limit and runs in one transaction with every insert. One row
  that fails its insert rolls the whole drain back, and the next run meets the same row again.
- `mail.sendLink` (`:463`) throws on a refusal, which ends the run: one bad recipient stops every later e-mail until it
  is fixed by hand.
- `ctx.links.issue` (`:456`) and recording the link's id are two steps. A crash between them leaves a live link whose id
  no row holds, so nothing revokes it.
- The `Mailer` sends no idempotency key, so the at-least-once e-mail (`:482`) is a second e-mail whenever the answer or
  the commit after it is lost. `@fabrika/email`'s `EmailMessage` requires `idempotencyKey` and sends it as
  `Idempotency-Key` (`packages/email/src/resend.ts:53`); the recipe does not use it.
- The recipe says a job's statements need no scope fragment (`:494`); a review of an application built on the paved
  road asked for one on every scoped table anyway, so a later narrowing of the job's reach keeps working.

An application built on the paved road hand-built per-delivery states, a key per delivery, a stored rendered message
for retries and an `unknown` state for an unanswered hand-off.

## Approach / acceptance

- The recipe drains in bounded batches (`limit`, `for update skip locked`) and records an attempt count and the last
  failure per record. A record that fails N times moves to a dead-letter state that an operator sees, and the run goes
  on with the rest.
- Every external call carries a key derived from the record (the e-mail's `Idempotency-Key`, the link issue's
  correlation if IAM takes one). Decide whether IAM's `issue` takes an idempotency key, which closes the link window.
- Decide the job-SQL scope rule once, and state it in the recipe.
- Witness: a recipe test with a poisoned inbox row and a refusing recipient, where every other record is processed
  and the bad ones end in the dead-letter state. A fault after the provider's acceptance needs
  [117](117-an-application-test-cannot-inject-a-database-fault.md).

## Touch points

`packages/app/skill/references/{public-intake.md,jobs.md}`, `packages/email/src/email.ts`,
`packages/app/src/implement/membership.ts` (only if IAM's issue takes a key), `packages/iam/`.
