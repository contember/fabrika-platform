---
id: 188
title: Application mail follow-ups from the review
blocked-by: []
---

# 188 — Application mail follow-ups from the review

**Summary.** Six small gaps the review of the application-mail work found and did not block on: release notes for
two upgrade edges, a refusal reason IAM could word better, and three runtime edges of `ctx.mail` and `then`. Each is
small; none loses data.

## Problem

1. **A stricter display name can refuse an IAM sender that started before.** `isValidEmailDisplayName`
   (`packages/email/src/validation.ts:47`) now refuses `"` and `\`. An installation whose `FABRIKA_EMAIL_FROM` is
   `Acme "Ops" <ops@example.com>` passed before; after the upgrade IAM refuses to start (Node), or the Cloudflare
   pipeline fails. Only an unusual value is affected, and the release notes do not say so.
2. **An existing Cloudflare installation keeps its old workflow.** `platform.yml`
   (`packages/provider-cloudflare/src/installation/templates/platform.yml:144`) now passes
   `FABRIKA_EMAIL_FROM_NAME` and the SmartEmailing variables, but only `platform init` rewrites the workflow. Resend
   keeps working; switching to SmartEmailing needs `init` re-run, and nothing on the upgrade path says so.
3. **A failed invitation retried without `resend` sends nothing new.** When the send outcome is `unknown`, the
   invitation stays open and the caller gets `delivery_failed` (`packages/iam/src/membership.ts:506`). A retry
   without `resend: true` answers the open invitation and sends no e-mail, although the first may never have arrived.
4. **An attempt retry can resend earlier mail over a non-idempotent transport.** A retry reruns the whole handler
   (`packages/app/src/jobs/runner.ts:716`). A `not_sent` retryable failure (`rate_limited`) after earlier successful
   sends of the same attempt sends those again over SmartEmailing, unless the handler committed a "sent" state for
   each record. `references/jobs.md` teaches one transaction per record, which prevents it.
5. **A handler that ignores its signal can outlast the drain.** After `SHUTDOWN_DRAIN_MS`
   (`packages/app/src/bun.ts:134`, drained at `:414`) the database closes under a kicked run that still holds a
   transaction. The error is caught and logged as a background-task failure, and the work rolls back.
6. **`then` is a silent no-op without a data layer.** On a contract served with `database: null`, `kick`
   (`packages/app/src/jobs/runner.ts:357`) finds no framework tables (`framework === null`, `:330`) and runs nothing.

## Approach / acceptance

1. One line in the release notes of the release that ships it: a display name with `"` or `\` is refused; rename it
   before the upgrade.
2. One line in the Cloudflare installation reference (or in backlog 187's command): re-run `platform init` to pick up
   the new workflow before switching provider.
3. Either document that `resend` is the retry after `delivery_failed`, or answer a distinct `delivery_unknown`. A
   test pins whichever is chosen.
4. Optionally make `mail_failed` final over a non-idempotent transport once the attempt has sent anything. A runner
   test with a non-idempotent Memory sender witnesses it.
5. No change needed unless the noise matters; a log line that names the job is enough.
6. Refuse `then` at the builder or at boot when the contract has no data layer, if that combination can occur; a boot
   test witnesses the refusal.

## Touch points

`packages/email/src/validation.ts`, `packages/provider-cloudflare/src/installation/`, `packages/iam/src/membership.ts`,
`packages/app/src/jobs/runner.ts`, `packages/app/src/bun.ts`, `packages/app/src/implement/build.ts`, release notes.

<!-- Origin: the independent review of the application-mail pull request (its P3 findings). -->
