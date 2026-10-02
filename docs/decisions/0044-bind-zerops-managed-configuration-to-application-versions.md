---
id: 0044
title: Bind Zerops managed configuration to application versions
status: accepted
date: 2026-09-28
---

# 0044 — Bind Zerops managed configuration to application versions

## Context

Live probes showed that service-variable writes survive failed and cancelled candidates, so restarting
old code can expose candidate configuration. Explicit rollback also retained newer service variables.
Native pipeline environment fields did not establish an atomic binding for uploaded sources.

Immutable service values selected by references in a version's `run.envVariables` preserved code/config
pairing through failure, cancellation, restart and rollback in single-container probes. Converting
legacy canonical variables to references and then rolling back could instead remove the canonical
values. The first production installation is new; automatic legacy migration is not required.

The existing deployment lock expires before the maximum provider wait. Reconciliation does not acquire
that lock, and checkpoints lack invocation fencing. Immutable values alone do not prevent two invocations
from submitting or finalizing conflicting work.

## Decision

For newly provisioned applications, bind all six Fabrika-managed runtime keys to each application
version. Store non-null values as create-only service secrets under version-specific names. The
execution descriptor maps canonical keys to those references; null means omission, not an empty value.
Retain referenced secrets for rollback. Ordinary application-secret rotation remains separately mutable.

**Invariant:** secret values never enter provider checkpoints, source descriptors, manifests or logs.
Original source descriptor bytes/digest retain the identity defined by ADR-0043; only the validated
execution document receives platform-owned references.

Record a complete managed-key map, explicit absences, confirmed backing-record IDs, frozen coordinates,
and artifact identity in the nonsecret checkpoint. Recovery does not regenerate values from today's
catalog. Incomplete unconfirmed staging fails before submission. Once submission may have happened,
continue observing the recorded version rather than resubmitting or declaring failure merely because
a local wait expired.

Establish a create-only ownership marker during fresh provisioning. Initial application provisioning
uses a collision-rejecting import (`override: false`); canonical stored manifests and steady-state
imports retain `override: true`. This narrowly changes the first-registration emission rule, not the
operator-authored resource contract. Await the returned provisioning processes and establish ownership
only when creation of that exact service is attributable to the operation. Ambiguous unmarked services
are not adopted automatically.

Subsequent deployments admit a coherent prior owned binding, including absences. Descriptor references
can appear as USER environment records; record type alone cannot distinguish legacy values. Reject
literal canonical values, unknown references and app-authored use of the reserved internal namespace.
The marker is an ownership convention, not protection against a privileged platform administrator.

Deploy, recovery and cancellation use renewable leases with unique invocation holders. Repository-owned
transactions serialize on the common app/environment lease row, verify holder/expiry and prior checkpoint,
and refuse starting another run while external work remains unresolved. Lease loss stops the old
invocation's effects; it is not user cancellation. Cancellation remains requested until external work
settles, and does not imply rollback when activation already won.

This amends ADR-0029's recovery rule for submission-intent checkpoints: an `UPLOADING` observation after
a fixed delay is not sufficient evidence that a potentially accepted request can no longer activate.
The source transporter and operator-owned installation boundary remain unchanged.

## Consequences

- New application versions have explicit code/configuration identity and keep rollback bindings.
- Legacy conversion requires a separate migration design; ordinary deploy refuses it.
- A partial provisioning attempt can require operator diagnosis rather than automatic adoption.
- Expired invocation leases permit recovery, but do not themselves release durable run exclusion.
- Unknown external outcomes can keep a run blocking until settlement is established.
- Retained per-version secrets consume service-variable capacity. No automatic reclamation is part of
  this change; referenced values must not disappear underneath rollback-eligible versions.

## Alternatives considered

- Native pipeline secret fields: the tested upload/rollback behavior did not provide the required binding.
- Compensating canonical writes after failure: old code can restart during the failure window, and late
  compensation can overwrite a newer run.
- Keep only release identity versioned: simpler, but changes the approved rollback contract for the
  remaining managed keys.
- Separate candidate services or a runtime configuration fetch: adds topology or runtime dependencies
  unnecessary for the measured reference-selection primitive.
