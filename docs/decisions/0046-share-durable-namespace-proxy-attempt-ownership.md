---
id: 0046
title: Share durable namespace proxy attempt ownership
status: accepted
date: 2026-10-02
---

# 0046 — Share durable namespace proxy attempt ownership

## Context

ADR-0045 pins namespace proxy sources, but exact source identity alone does not serialize builds.
Namespace provisioning has durable checkpoints; application `beforeDeploy` and registry republish
previously started proxy builds without that writer or namespace ownership. A lost submission response
could leave a build unknown to reconciliation and allow another request to start competing work.

## Decision

Provisioning, reconciliation, application `beforeDeploy` and registry republish share one durable
namespace proxy attempt and a renewable namespace lease. Use a unique invocation holder, retain the
reserved app-version ID and submission phase, and fence checkpoint writes against lease ownership
and the previously observed namespace state.

**Invariant:** an unresolved proxy attempt excludes competing builds across requests, replicas and
process restarts. Lease expiry permits recovery of the recorded attempt, not a competing submission.
Lease loss stops the old invocation's effects without authorizing cancellation of external work.

Keep namespace attempt state separate from an application's run checkpoint. Each rebuild uses the
namespace's persisted source pin; changing an installation default does not change existing pins.
Registry changes remain durable even if publishing their proxy manifest fails. A successful observation
must not claim that a newer registry manifest was applied by an older attempt.

Extend the existing namespace lifecycle and repository boundary. A process-local lock, latest-version
discovery or a version ID written only to logs is insufficient recovery evidence.

## Consequences

- All proxy rebuild callers use the same ownership and attempt protocol.
- Requests may wait for the approved bounded source upload or report contention/unresolved work.
- Reconciliation can recover the exact attempt created by a request.
- Durable exclusion can remain after an invocation ends until settlement is established.
- Integration requires concurrency and crash-recovery tests in addition to exact-source tests.
