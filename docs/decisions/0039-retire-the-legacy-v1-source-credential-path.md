---
id: 0039
title: Retire the legacy v1 source credential path
status: accepted
date: 2026-08-21
---

# 0039 — Retire the legacy v1 source credential path

## Context

[ADR-0032](0032-support-multiple-private-github-source-connections.md) decided two things at once. It
designed the multi-connection model — one private GitHub App per organization, create-only keyed v2
credential slots, an explicit `(connectionId, installationId)` pair on every private operation, and a
scoped webhook per connection. It also kept a compatibility path, because one installation already
held a v1 credential: an unkeyed `GITHUB_APP_CREDENTIALS` bundle (or the older split
`GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY` pair) on `source`, a `legacy-v1` transport marker copied
into the keyed table, an adoption flow that promoted that credential into a connection, and the
unscoped `/webhooks/github` route reserved for it.

That credential existed in exactly one place: the `source` service of `fabrika-install-test`,
confirmed on 2026-08-21 beside three keyed v2 slots. The account has no second installation holding
one — the other project is an application namespace with no `source` service. That project is being
deleted, so the compatibility path is about to have nothing to be compatible with, and the live
witness the multi-connection sprint still owed for it can never go green.

Two paths that select credentials differently are not free. They are two decoders, two client
selectors, a marker every read has to branch on, an unscoped webhook route that must guess which
connection a delivery belongs to, and a `source` container that falls back to a default App when a
keyed slot is absent — the exact shape in which a keyed operation can answer for the wrong App.

## Decision

`keyed-v2` is the only source credential transport. This supersedes **only** ADR-0032's compatibility
clause; everything else ADR-0032 decided stands unchanged, as do [ADR-0029](0029-an-operator-owned-github-app-delivers-zerops-sources.md),
[ADR-0031](0031-manage-zerops-github-source-from-control.md) and [ADR-0036](0036-recover-a-source-credential-binding.md).

- The unkeyed `GITHUB_APP_CREDENTIALS` bundle and the split `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY`
  pair are no longer credentials. `source` reads only `GITHUB_APP_CREDENTIALS_V2_<digest>` slots, holds
  only a connection-keyed client map, and has no default client to fall back to. A leftover value is
  ignored, not adopted. This is Zerops-specific: a Cloudflare composition keeps its own static
  `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` worker configuration, which was never this path.
- Adoption is gone: there is no operation that promotes an existing credential into a connection, no
  `adoption` setup kind, and no `adoption-required` console state. An installation that predates keyed
  slots creates a new connection.
- A v1 source request that names a GitHub installation id has no credential to select and is refused
  (`installation_not_found`). The v1 `resolve`/`upload`/`cancel` wire survives as the **anonymous
  public-repository** path and nothing else; the v1 credential `activate`/`status` endpoints and the
  `/v1/installations/resolve` lookup are removed. Registration resolves the pair from the connected
  organization instead.
- Every webhook is scoped. In a Zerops composition the unscoped `/webhooks/github` path resolves no
  connection and is refused before the body is read, rather than trying a stored secret. The route and
  its `public` gate remain, because a Cloudflare composition configures its App with exactly that URL
  and verifies it with a static secret and installation-id routing (ADR-0032).
- The singleton `github_source_connections` table is dropped and any `legacy-v1` row is deleted, in one
  new migration per engine. The `transport_kind` column and its CHECK stay as shipped: narrowing the
  CHECK on SQLite would need a full table rebuild, no writer can produce the value, and the row decoder
  refuses it.

**Invariants:**

- A private source credential reaches `source` only as a create-only keyed slot whose canonical bytes
  embed its connection id. There is no default, fallback, or unkeyed client.
- Selecting a credential requires a connection id. An installation id alone never does.
- A Zerops webhook delivery is authenticated by exactly one connection's secret, selected by the path.

## Consequences

- One credential model, one decoder, one client selector. A keyed operation can no longer answer
  through a neighbouring organization's App.
- There is no supported way to adopt a credential written before keyed slots existed. An installation
  in that state must create a new connection, which creates a new App.
- An application row backfilled to the deleted `legacy-v1` connection keeps naming it. That binding
  fails closed at `getZeropsSourceBinding` with an incomplete-binding error rather than resolving to
  another connection — deliberately, because the alternative is a silent reassignment.
- The migration deletes rows but not the vault entries those rows referenced. The orphaned ciphertext
  is unreferenced and unreadable without its purpose binding; deleting secrets from a migration is a
  larger risk than leaving them, so removal is left to a deliberate operation.
- Rolling `source` back to a build that expects the unkeyed bundle is unsupported, as it already was
  once a second credential existed (ADR-0032).

## Alternatives considered

- **Keep the compatibility path until a live witness passes.** Rejected: the only installation that
  could produce that witness is being deleted, so the gate can never go green and the code would stay
  forever on the strength of a promise.
- **Rewrite the v1 bundle into a keyed slot during the rebuild.** Rejected: it would keep an adoption
  mechanism alive for one credential that is being destroyed anyway, and slots are create-only by
  ADR-0031 for reasons that have not changed.
- **Delete the unscoped `/webhooks/github` route entirely.** Rejected: a Cloudflare composition
  configures its GitHub App with that exact URL and has no connection rows to scope by. Refusing the
  path inside the Zerops composition removes the ambiguity without breaking the other one.
- **Tighten the `transport_kind` CHECK to `keyed-v2` on both engines.** Rejected: SQLite would need a
  20-column table rebuild plus three indexes and a trigger, and tightening only Postgres would make the
  two schemas differ in what they accept. The application layer refuses the value on read.

## References

- [ADR-0029 — An operator-owned GitHub App delivers Zerops application sources](0029-an-operator-owned-github-app-delivers-zerops-sources.md)
- [ADR-0031 — Manage the Zerops GitHub source connection from control](0031-manage-zerops-github-source-from-control.md)
- [ADR-0032 — Support one private GitHub source connection per organization](0032-support-multiple-private-github-source-connections.md)
- [ADR-0036 — Recover a source credential binding from durable state](0036-recover-a-source-credential-binding.md)
