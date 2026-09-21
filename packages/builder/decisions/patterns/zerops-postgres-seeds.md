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
  - where: "examples/zerops-app/src/migrate.ts + src/notes.ts in fabrika-platform"
    read: "PostgreSQL access through Bun SQL and repeatable migration behavior."
---

# Named PostgreSQL fixtures

Apply this to the preset's local PostgreSQL database. An opice scenario naming
`seeds: ['example']` requires `seeds/example.sql`. Run migrations first, then apply
the named SQL files through the application's PostgreSQL driver or `psql` before
the scenario. Document that local seed command in the scaffold.

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
