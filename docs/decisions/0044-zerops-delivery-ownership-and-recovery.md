---
id: 0044
title: Zerops delivery binds the release, recovers by poll or delete, and runs under one lease
status: accepted
date: 2026-10-07
---

# 0044 — Zerops delivery binds the release, recovers by poll or delete, and runs under one lease

## Context

Zerops service variables are mutable service state. A failed or cancelled build leaves new values in
place, and the next restart of the old code reads them. A rollback to an archived version also boots
with the current values ([platform facts](../reference/zerops-platform.md#verified-live-2026-09-23-account-prg1--service-variables-across-activation-and-rollback)).
Fabrika writes seven managed keys into an application service: `FABRIKA_RELEASE`,
`FABRIKA_OPERATIONS_DSN`, `FABRIKA_IAM_ISSUER`, `FABRIKA_IAM_APP_ID`, `FABRIKA_APP_ID`,
`FABRIKA_ENVIRONMENT` and `FABRIKA_SERVICE_KEY`. If a deploy writes them as service variables and then fails, the old code
restarts with the candidate's values. For `FABRIKA_RELEASE` that is wrong data: errors and source maps
from the old code are attributed to a release that never ran. The other six keys change only when the
platform is reconfigured, and a newer value reaching older code is correct, not harmful.

The execution descriptor sent with a build (`zeropsYaml` on `build-and-deploy`) belongs to that one
version. Its `run.envVariables` therefore travel with the code, through failure, cancellation, restart
and rollback ([platform facts](../reference/zerops-platform.md#verified-live-2026-09-23-account-prg1--version-selected-environment-references)).

A deploy is a sequence of external steps: reserve a version, upload source, trigger the build, wait.
Control can crash or lose ownership between any two of them. Deleting a reserved version is a reliable
barrier: a later upload to it returns HTTP 200 but leaves nothing buildable, and a build request
against it fails with `appVersionNotFound` ([platform facts](../reference/zerops-platform.md#deleted-version-upload-race-witness-2026-10-03)).

Runs and namespace-proxy rebuilds both need one writer at a time across requests, replicas and process
restarts. A lease that outlives a dead holder by half an hour blocks the next deploy for that long.

## Decision

### Only the release identity is bound to a version

We will write `FABRIKA_RELEASE` as a literal into the selected setup's `run.envVariables` of the
execution descriptor that triggers the build. It is never a service variable. The other managed keys
are plain service variables that each deploy overwrites with the current value; absent values are
removed.

The execution descriptor is an overlay. The source descriptor's bytes and digest keep the identity that
ADR-0043 defines. Application-authored descriptors and secrets must not set any managed key.

**Invariant:** secret values never enter provider checkpoints, source descriptors, manifests or logs.

### Recovery does not resume

The run checkpoint is a small provider-owned JSON record stored with the run
(`runs.provider_state_json`). On Zerops it is `{ appVersionId, triggered }`. Only the lease holder
writes it, and the provider parses it with a schema when it reads it. It is not a phase machine and is
not written by compare-and-swap.

Control records `appVersionId` before it uploads source. It sets `triggered` before it sends the
build request.

When a new owner finds an unfinished run — after a restart, a lost lease or a cancellation — it does
not replay steps. It settles the run in one of two ways:

- `triggered` is not set: delete the exact version, then mark the run failed, or cancelled if a cancel
  was requested.
- `triggered` is set: poll the version to a terminal state and finish the run from that outcome. A
  cancel request asks Zerops to cancel the build and keeps polling. If the version activates anyway,
  the run succeeds; cancellation never implies rollback.

**Invariant:** a version whose build may have been submitted is settled only by polling it, never by
deletion.

A cancelled source upload is best-effort cleanup. Deleting the version, not stopping the transfer, is
what excludes the candidate from activation.

### Namespace proxy rebuilds follow the same rules

Provisioning, reconciliation, application `beforeDeploy` and registry republish rebuild a namespace's
proxy through one path. The attempt is recorded on the namespace row with the same two facts and is
settled by the same poll-or-delete rule. It stays separate from any application run's checkpoint. A
registry change stays durable even if publishing its proxy manifest fails.

### One lease primitive

Every run, on both clouds, and every namespace-proxy attempt runs under one lease primitive. The key
is the app/environment for a run and the namespace for a proxy attempt. A lease has a unique holder,
a TTL of about 90 seconds, and is renewed every 30 seconds.

- Every write to the leased row checks the holder. A failed check stops the invocation.
- Control is the only writer of a run's row. The Cloudflare runner reports its outcome; Control applies
  it under the lease.
- Cancellation is read at step boundaries, not by a background poll of the row.
- A new run for an app/environment first settles any unfinished run for it under the same lease.
- A pending run that a newer run of the same app/environment already superseded by succeeding never starts. Under
  the lease, one fenced write fails it, and its log names the newer run (`superseded by run <id>`). Queue order is
  not run order, because a deferred run is enqueued again; the UUIDv7 run id is. A rollback is a new run
  ([ADR-0050](0050-approved-access.md) §6).

**Invariant:** an unsettled attempt excludes competing builds for the same app/environment or namespace.
Lease expiry lets the next holder settle the recorded attempt; it never permits a second submission
beside it. Lease loss stops the old invocation's effects and gives it no permission to delete or cancel
external work.

## Consequences

- Failed or cancelled candidates cannot change the release identity that old code reports.
- Accepted risk: a rollback runs with the current, not the historical, values of the six non-release
  keys. A newer issuer, DSN, service key or name reaching older code is benign.
- No ownership markers, no admission of a prior binding, and no per-version service secrets. Nothing
  accumulates on the service, so nothing needs reclamation.
- A Control restart fails or finishes an in-flight deploy; it never continues it, and it never requeues one:
  the run's snapshot publication, its Operations projection and the provider checkpoint would each need a
  replay rule (see the rejected resume below). A run failed this way ends its log with
  `deploy interrupted: …; run the deploy again`, so the user knows to redeploy.
- A dead holder blocks its key for at most about 90 seconds.
- Deletion does not guarantee upload-URL revocation, stopped transfers or physical blob cleanup.
- A long step must check the lease and cancellation at its own boundaries; a step that never yields
  delays cancellation until it ends.

## Alternatives considered

- **Bind all seven managed keys to each version** as create-only per-version service secrets selected
  by references in `run.envVariables`, with an ownership marker, admission of the prior binding, and a
  collision-rejecting first import. It also restored historical non-release keys on rollback. It lost:
  the six other keys do not need history, it needed an admission protocol and legacy-conversion rules,
  and the per-version secrets were never reclaimed.
- **Native pipeline secret fields (`envSecretsFile`).** They changed service records even when the
  build failed and did not bind values to the uploaded version.
- **Compensating writes after a failure.** Old code can restart inside the failure window, and a late
  compensation can overwrite a newer run.
- **Resume from a multi-phase checkpoint** (staging, staged, uploaded, trigger requested, triggered)
  with checkpoint compare-and-swap and a confirmed-absence settlement protocol. Resuming saves one
  redeploy after a rare crash; it cost a replay path per phase and fenced writes on every checkpoint.
- **A 30-minute lease with a per-run database poll for cancellation.** A dead holder blocked deploys
  for the full TTL, and the poll loop added load and a second failure path for no faster outcome than
  checking at step boundaries.
- **A shared durable upload coordinator** to prove that every transfer stopped. Version deletion already
  gives the guarantee a deploy needs.
