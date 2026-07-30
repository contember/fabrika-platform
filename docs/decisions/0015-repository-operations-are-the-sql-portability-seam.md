---
id: 0015
title: Make repository operations the SQL portability seam
status: accepted
date: 2026-07-30
---

# 0015 — Repository operations are the SQL portability seam

## Context

IAM and control originally put all persistence methods in one `Db` class and ran one SQL body against
D1/SQLite and Postgres through the D1-shaped `SqlDatabase` port. This kept ordinary CRUD small, but it
also made the SQLite/Postgres common SQL subset a hard architectural boundary.

Equivalent domain operations do not always have equivalent query shapes. A correct or efficient
operation may be one statement on Postgres and an atomic batch or a different algorithm on SQLite.
Choosing at the prepared-query level is too narrow because the difference can include transaction
boundaries, intermediate results, locking, and result mapping. Adding a backend discriminator to
`SqlDatabase` would instead spread dialect branches through shared persistence code and would remove
D1's structural conformance to that port.

Both existing `Db` classes have also grown across independent persistence capabilities. IAM combines
principals, grants, app vocabulary, credentials, sessions, and audit. Control combines apps,
deployment namespaces, environments, configuration, runs, and repository polling.

## Decision

We will split IAM and control persistence into capability repositories. A repository operation is the
smallest SQL portability seam: one implementation owns all statements, atomicity, intermediate
results, and mapping needed to preserve that operation's domain contract.

Portable operations will keep one implementation over `SqlDatabase`. A runtime may replace an entire
capability repository with a SQLite- or Postgres-specific implementation when correctness, atomicity,
or material performance requires it. The installation composition root selects the repository
bundle; shared business logic never branches on a database identifier.

We will not create empty per-dialect subclasses. A capability remains shared until a real divergence
exists. Every divergent implementation must pass the same behaviour contract on its real backend.

`SqlDatabase` remains D1-shaped and dialect-neutral. DDL remains in the existing per-dialect migration
sets. Runtime-specific infrastructure such as the Postgres job queue remains a separate platform
capability rather than a repository dialect branch.

## Consequences

- One Postgres statement and a multi-statement SQLite implementation can implement the same repository
  operation without leaking their mechanics to callers.
- Ordinary CRUD stays shared and does not acquire duplicate query bodies.
- IAM and control callers depend on focused capabilities instead of a monolithic `Db`.
- Composition roots gain responsibility for selecting and assembling repository bundles.
- Cross-capability atomic operations need an explicit owning capability rather than transactions that
  span unrelated repositories.
- Adding a dialect-specific operation requires behaviour tests on both backends; syntax portability
  alone is not sufficient evidence.

## Alternatives considered

### Keep every query in the SQLite/Postgres common subset

This remains a useful default but is too strong as an invariant. It cannot represent backend-specific
locking, transaction shapes, or materially different algorithms.

### Add `dialect: 'sqlite' | 'postgres'` to `SqlDatabase`

This is mechanically simple but distributes backend conditionals through repository methods and makes
a native D1 binding stop satisfying the port structurally.

### Inject prepared-query strategies

This handles textual SQL differences but not operations whose statement count, control flow, or
atomicity differs by backend.

### Duplicate complete IAM and control repositories per backend

This permits every divergence but duplicates the much larger portable surface and makes behavioural
drift likely.
