---
id: 0047
title: Settle pre-trigger cancellation by confirmed version deletion
status: accepted
date: 2026-10-03
---

# 0047 — Settle pre-trigger cancellation by confirmed version deletion

## Context

Source cancellation requests abort an instance-local upload. They do not prove termination across
replicas or exclude delayed requests after a restart. Providing that stronger guarantee would require
shared coordination beyond the existing source runtime.

Source can upload bytes to a reserved version but cannot submit a build or change managed configuration.
The required deployment guarantee is exclusion of candidate activation, not termination of every transport.
Live deletion-before-upload and deletion-during-upload witnesses left the exact version absent and
unbuildable even though the original upload URL subsequently returned HTTP 200. See the
[platform evidence](../reference/zerops-platform.md#deleted-version-upload-race-witness-2026-10-03).

## Decision

For application and namespace-proxy attempts durably known to be pre-submission, settle cancellation
after deleting the exact reserved version and confirming its absence through the verified
`400 appVersionNotFound` response. Existing ownership and checkpoint fencing must exclude subsequent
build submission before cleanup starts. Unknown deletion or observation outcomes retain recoverable
state. Clear that state only through a live owner's guarded write.

Source cancellation is best-effort resource cleanup. Its success is not termination evidence, and its
failure does not prevent settlement when exact-version deletion and build exclusion are established.
No shared source-operation ledger or new persistence is introduced.

**Invariant:** never use this rule to settle a potentially submitted build. A durable
`build_trigger_requested` checkpoint remains ambiguous unless the current invocation can positively
establish that submission never started. Recovery cannot infer this from an `UPLOADING` observation,
a local timeout, or lease expiry. Lease loss grants no permission to delete or cancel external work.

This amends ADR-0044's cancellation settlement boundary and applies it to ADR-0046's shared proxy
attempts: settlement excludes activation-capable work; it does not promise transport termination.
Immutable bindings, retained rollback values, durable build exclusion and observation of uncertain
submissions remain required. Cancellation after activation does not imply rollback.

## Consequences

- Pre-trigger cleanup uses the existing exact-version API and durable ownership protocol.
- An upload may finish after cancellation and return HTTP 200 without restoring a buildable version.
- Settlement does not guarantee signed-URL revocation, physical blob reclamation or stopped transfers.
- Uncertain build submission continues to block competing deployments until externally settled.

## Alternatives considered

- A shared durable upload coordinator: needed for stronger transport guarantees, but unnecessary for
  the selected deployment guarantee supported by the live witnesses.
- Local completion waits and in-memory tombstones: cannot establish cross-replica or restart safety.
- Treating upload abort acknowledgement as settlement: reports a guarantee the source service does
  not provide.
