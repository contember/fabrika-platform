---
id: 0036
title: Recover a source credential binding from durable state
status: accepted
date: 2026-08-20
---

# 0036 — Recover a source credential binding from durable state

## Context

ADR-0032 made each v2 source credential slot create-only and left credential rotation undecided. A
completed Control row retains only the credential digest; its encrypted recovery copy is deliberately
deleted. A live repair restored a missing slot with another active private key for the same GitHub App.
Private repository deploys worked, but Control still held the previous digest. Webhook reconciliation
therefore failed before it could restore the webhook, and neither the discarded key nor its digest-bound
bundle could be recovered.

Deleting and recreating the connection is not a safe repair. Application bindings are sticky, the
existing GitHub installation and webhook secret remain valid, and the durable source slot already
proves which credential the runtime can use. Control needs a bounded way to recover its nonsecret
binding without making private-key rotation a browser or database operation.

## Decision

A same-origin human reconciliation may rebind a stable Control row to the credential already durable
under that row's exact source connection id. It first asks source for the active credential digest and
verified GitHub App identity. The identity must exactly match the stored App id, slug, URL, visibility,
organization, `contents: read` permission and sole `push` event.

Control then uses the existing purpose-bound vault secret to configure and structurally verify the
stored webhook URL through that active credential. Only after this succeeds may it compare-and-set the
row from its previous version and digest to the source-reported digest. A concurrent change either
already has the same digest or returns a conflict. The operation does not read, copy, replace or delete
the source bundle; change the connection id, transport, App, installation, webhook secret or application
binding; or expose either digest in a browser DTO.

An inactive source credential or an App identity mismatch is a `409` state conflict. A source inspection
or webhook call that cannot complete is a bounded `503` dependency failure. Reconciliation does not
collapse either case into a generic `502`.

This amends ADR-0032's decision to leave rotation semantics out of scope. It adds only adoption of an
already durable same-App credential. Creating a replacement slot, deleting a credential or changing the
GitHub App remains out of scope.

## Consequences

- A lost temporary recovery copy no longer makes a same-App credential repair irrecoverable.
- The source slot remains create-only and private-key custody does not expand beyond source.
- Webhook configuration proves the replacement credential can administer the exact App before Control
  accepts its digest.
- Reconciliation can change the connection row's version and credential digest, so callers must treat it
  as a repair operation rather than a read-only replay.
- Recovery cannot adopt a credential for another App, organization or permission set.

## Alternatives considered

- **Keep returning a digest conflict.** Rejected because the deleted recovery copy makes the stable
  connection impossible to repair through supported operations.
- **Delete and recreate the connection.** Rejected because source slots and application bindings are
  durable, and deletion semantics remain undefined.
- **Update the digest directly in the database.** Rejected because it proves neither source custody nor
  GitHub App identity and bypasses the human audit boundary.
- **Persist every private key indefinitely in Control.** Rejected because it expands credential custody
  and contradicts ADR-0031's bounded recovery lifetime.

## References

- [ADR-0031 — Manage the Zerops GitHub source connection from control](0031-manage-zerops-github-source-from-control.md)
- [ADR-0032 — Support one private GitHub source connection per organization](0032-support-multiple-private-github-source-connections.md)
