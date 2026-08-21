---
id: 79
title: A namespace's stored target cannot be changed after creation
blocked-by: []
---

# 79 — A namespace's stored target cannot be changed after creation

**Summary.** A deployment namespace's provider target is written once, at creation, and no API accepts
a new one. Changing a declared PostgreSQL type or profile — the choice
[ADR-0038](../decisions/0038-size-namespaces-cheaply-by-default.md) makes an explicit act — means
editing `deployment_namespaces.provider_target_json` by hand, and even that fails against a live
service. Effort M.

## Problem

The only two verbs that carry a target are `namespaces.create` and `namespaces.adopt`
(`packages/control-contract/src/rpc.ts`), and both refuse an id that already exists with
`409 deployment namespace already exists` (`packages/control/src/api/namespaces.ts`). The verb that
re-applies an existing namespace, `namespaces.reconcile`, takes `NamespaceIdInput` — an id and nothing
else. Its handler reads the row and rebuilds the provider namespace from the stored
`provider_target_json`; the caller has no way to supply a different one. The REST router matches this:
`POST /api/namespaces`, `POST /api/namespaces/:id/adopt`, `POST /api/namespaces/:id/reconcile`, and no
update route at all (`packages/control/src/api/router.ts`).

Hand-editing the stored JSON does not rescue it either. On reconcile, `validateService`
(`packages/provider-zerops/src/namespace.ts`) throws when the live service disagrees with the declared
target: a changed `postgres.type` trips the `base` check whenever the live service reports a base, and
a changed `postgres.profile` trips the `autoscalingProfileId` check, which runs whether or not the
namespace is being adopted. So the declared target and the live service can only be moved together, and nothing in this
repository moves either.

Combined with [73](73-a-failed-namespace-cannot-be-removed.md) — no delete — a namespace sized wrongly
at creation cannot be resized, cannot be recreated under its own id, and holds that id forever. That
makes the one decision `create` asks for irreversible in practice, which is a poor property for a
decision about cost.

## Approach / acceptance

Decide first which of the two shapes this is, and record it:

- **A namespace target is mutable.** `reconcile` (or a new `namespaces.update`) accepts a target, the
  provider is asked to move the live service to it, and `validateService` distinguishes "the live
  service disagrees with what we declared" from "the live service is what we are about to change".
  Zerops silently ignores a changed `profile` on re-import
  (`docs/reference/zerops-platform.md`), so this needs the dedicated autoscaling endpoint, not another
  import.
- **A namespace target is immutable, and that is stated.** Then the fix is a delete plus recreate path
  ([73](73-a-failed-namespace-cannot-be-removed.md)), and the API says so rather than leaving an
  operator to guess.

Acceptance: a namespace created on the ADR-0038 defaults is moved to `postgresql:ha@18` at
`oltp-production` — or is refused with an error that names the supported path — through the public API
alone, with no SQL and no editing of `provider_target_json`. A test witnesses the transition end to
end against the fake Zerops API.

## Touch points

`packages/control-contract/src/rpc.ts`, `packages/control/src/api/namespaces.ts`,
`packages/control/src/api/router.ts`, `packages/provider-zerops/src/namespace.ts`,
`packages/provider-contract/` (if the namespace capability grows a verb), `packages/dashboard/`.

<!-- Origin: sprint-2026-08-21-cheap-rebuild-from-scratch, WU0 — found while recording ADR-0038. -->
