---
id: 204
title: A redelivered push webhook creates a second run
blocked-by: []
---

# 204 — A redelivered push webhook creates a second run

**Summary.** The webhook handler keeps no record of the pushes it has turned into runs, so a redelivery of the same
push creates and enqueues another run of the same commit. Deduplicate over the signed push content. P3, size S–M.

## Problem

`handleWebhook` (`packages/control/src/github/triggers/webhook.ts:28-77`) verifies the HMAC, then creates a run for
every environment whose `trigger_ref` matches, each with a new UUIDv7. Nothing tells a redelivery from a new push. A
redelivery is a manual action of the GitHub App's administrator ("Redeliver" in the delivery log) or GitHub's own retry
after a timeout. The second run deploys the same commit again.

- For a branch, a run whose ref has moved on refuses itself (the Zerops source check, and on Cloudflare the run-order
  fix), so a late redelivery of an old push deploys nothing. A redelivery of the current push still deploys the same
  commit twice.
- For a tag (`refs/tags/v*`), the ref does not move: a redelivery of an old release's push deploys that release
  again, after the newer one. Marking a run superseded by a newer successful run does not stop it: the redelivery's
  run is the newer one.

`X-GitHub-Delivery` is not covered by the signature, so it cannot be the key alone; the push body is.

## Approach / acceptance

Record each accepted push by a key the signature covers: the connection, the repository, `ref`, `before` and `after`
(decode `before` in `pushPayloadSchema`, `packages/control/src/github/triggers/push-event.ts:145-150`), or the SHA-256
of the raw signed body. A push whose key is recorded answers 200 with the runs it created the first time and creates
none. Keep the record for a bounded window (a redelivery of a push older than that window is rare and is the
administrator's explicit act). Decide whether the window is a fixed age or the life of the run rows.

Migration on both dialects (`migrations/` and `migrations-postgres/`, per `packages/control/DATABASE.md`): a table
keyed on the delivery key with a creation time, or a unique key on the runs it created. Rollout on an existing
installation: the table starts empty, so only pushes after the upgrade are deduplicated.

Witness: a webhook test that posts the same signed body twice and gets one run, and one that posts two pushes with the
same `after` and a different `before` (a force-push back) and gets two.

## Touch points

`packages/control/src/github/triggers/webhook.ts`, `packages/control/src/github/triggers/push-event.ts`,
`packages/control/src/db/`, `packages/control/migrations/`, `packages/control/migrations-postgres/`.

<!-- Origin: a platform review; the run-order fix covers a late branch redelivery. -->
