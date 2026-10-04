---
id: 95
title: Close release recovery without frozen context
---

# 95 — Close release recovery without frozen context

**Summary.** Decide durable release-intent ownership and credential-expiry semantics before closing the recovery gaps that terminal replay cannot reconstruct honestly.

## Problem

Control's bounded terminal repair in `packages/control/src/operations-releases.ts` can repair only existing release outbox contexts. A run with no context lacks durable dry-run identity, original upload verifier/expiry, and exact artifact outcome. `RunRow` does not contain those facts. Current registry configuration or a newly generated credential is not evidence of the original deployment.

The release parser also requires `uploadCredential.expiresAt > observedAt`. A terminal observation after the frozen expiry cannot be repaired by retaining that credential under the current contract. Backdating the observation, extending expiry, or replacing the credential would change stored identity or authority.

## Approach / acceptance

1. Decide who persists release intent and when, before provider effects. Define behavior when that persistence fails.
2. Decide where exact artifact evidence becomes durable and how both the runner co-write and Control's post-runner correction use it.
3. Decide whether an expired upload verifier may accompany a later terminal observation, independently of accepting artifact uploads. Preserve authority and historical identity; record any protocol change in an ADR.
4. Implement only after those decisions are approved. Keep provider-neutral ownership, dual-runtime SQL transaction fencing and migration identity.
5. Witness missing-start-context recovery, dry runs, exact artifact results, late completion past expiry, process interruption, and fast-runner/post-runner correction on SQLite and real PostgreSQL. Repeated replay must create no additional semantic revision.

## Touch points

- `packages/control/src/run-lifecycle.ts`, `operations-releases.ts`, and `db/operations-releases.ts`
- Control's run persistence and both migration bundles if approved decisions require new records
- `packages/operations-contract/src/releases.ts` and Operations release/artifact handling
- Runner outcome and terminal co-write boundaries

Origin: [platform simplification sprint](../sprints/sprint-2026-10-04-platform-simplification.md).
