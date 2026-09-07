---
id: postgres
kind: technology
title: PostgreSQL (relational database)
slot: relational-db
provides: [relational-db, sql, mutable-state, transactions]
requires: []
recommends: []
conflicts: [d1]
npm: []
status: stable
sources:
  - where: "postgresql.org/docs + the driver you use (e.g. `pg`, `postgres`)"
    read: "Connection/pooling model, transactions, and row-level security if you use it directly."
  - where: "contember-oss/docker-compose.yaml + packages/database"
    read: "A real Postgres-backed setup (Contember Engine) and a fluent query/pool layer over `pg`."
---

# PostgreSQL

## What it is

The general-purpose relational database for stacks that need a **full SQL server**
(rich types, transactions, extensions, mature tooling) rather than edge SQLite.
Required by `contember`; the default store when you run a **Node backend** instead
of Workers + D1.

## When & why to use

- You adopt `contember` (it mandates Postgres) or any Node backend needing a real RDBMS.
- You need Postgres-specific features (JSONB, full-text search, extensions, strong transactional guarantees) D1/SQLite lacks.

## When NOT to use

- **Cloudflare Workers-first** apps → use `d1` (edge SQLite, local-first, no server). Workers can't open a raw Postgres TCP connection without Hyperdrive/a proxy.
- A small local-first app where SQLite is plenty.

## Impacts & gotchas

- You **run and operate a Postgres server** (managed service, container, or self-hosted) — connection strings, pooling, backups.
- From Workers, direct connections need **Hyperdrive or an HTTP proxy**; the natural home is a long-lived Node process.
- Migrations are yours (or your framework's, e.g. Contember's diff-generated ones).

## Relationships — why

- **conflicts `d1`** — same `relational-db` slot; one relational store per app. Postgres = server-side RDBMS, D1 = edge SQLite.
- **required by `contember`** — its schema/migration/ACL layer is Postgres-specific.
