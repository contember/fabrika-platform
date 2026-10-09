---
id: zerops-postgres-seeds
kind: pattern
title: Named PostgreSQL fixtures for local Zerops application tests
slot: seed-strategy
provides: [seed-strategy, foundation-manifest]
requires: [postgres]
recommends: [opice]
conflicts: [named-seeds]
status: stable
sources:
  - where: "packages/builder/decisions/technologies/opice.md in fabrika-platform"
    read: "Scenario seeds metadata and its filename contract."
  - where: "examples/zerops-app/db/migrations/ + src/db/tables.ts in fabrika-platform"
    read: "The application schema, its scope columns, and the table policies a seeded row must satisfy."
  - where: "packages/cli/CLAUDE.md (the `db` area) in fabrika-platform"
    read: "`fabrika db migrate` and its environment: `FABRIKA_APP_ID`, `FABRIKA_APP_DATABASE_URL`, schema `app_<id>`."
---

# Named PostgreSQL fixtures

Apply this to the preset's local PostgreSQL database. An opice scenario naming
`seeds: ['example']` requires `seeds/example.sql`. Run `fabrika db migrate` first,
then apply the named SQL files with `psql` against the application's schema
`app_<id>` (`SET search_path`) before the scenario. Document that local seed
command in the scaffold. Seeds are a local test tool, not application code: the
application reaches rows only through its scoped stores, and the checker refuses
raw SQL and database drivers in it.

A seeded row must look like one the data layer wrote: it carries its whole
containment chain (every scope column of its table policy) and its `createdBy` and
`version` columns where the policy names them, so the access forms find it in the
scope the scenario's principal is granted.

Use stable fixture IDs and PostgreSQL `INSERT ... ON CONFLICT` semantics so
repeated application is safe. Tests that mutate fixtures must restore their
required initial state or use isolated data. Keep fixture writes explicitly
targeted at the local test database; deployment migrations must not load them.

This preserves the catalog's named-seed metadata contract without selecting
`named-seeds`, whose hard dependency and commands are D1-specific. Do not use
`INSERT OR IGNORE`, lopata D1 commands or Wrangler database commands here.

Application data fixtures do not grant identity. Provision scenario principals
and permissions through the real local IAM setup; never manufacture an
application auth context from a seed name or role label. A genuinely
self-provisioning scenario can declare `seeds: []`.
