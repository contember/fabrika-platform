---
id: contember
kind: technology
title: Contember — GraphQL CMS / backend framework
slot: backend
provides: [graphql-api, content-model, acl, admin-ui, migrations, tenant-auth, multi-tenant]
requires: [postgres]
recommends: [react, bindx]
conflicts: []
npm: ["@contember/schema-definition", "@contember/react-binding", "@contember/interface", "@contember/client-content", "@contember/cli"]
status: stable
sources:
  - where: "contember-oss — packages/schema-definition (c.* DSL + @c.Allow ACL), CLAUDE.md, docker-compose.yaml"
    read: "The schema-as-code DSL (entities/relations/validation), predicate-based ACL, the engine architecture (Content/System/Tenant API), and local Postgres bootstrap."
  - where: "@contember/* on npm (installed types) + packages/client-content/tests/schema.ts"
    read: "The package surface an app imports (schema-definition, react-binding, client-content, cli) + a real sample schema."
  - where: "contember-oss/packages/playground/"
    read: "A minimal working app: schema + CLI config + admin wiring."
---

# Contember

## What it is

A **batteries-included GraphQL CMS/backend framework**. You declare the data model,
ACL, and validation as TypeScript decorators (`@contember/schema-definition`); the
engine auto-generates a GraphQL Content API (with row/field-level ACL enforced in
SQL), Postgres migrations (by diffing schema versions), a React admin UI, and a
tenant/identity system (sign-up, projects, memberships, roles, API keys). It is a
monolithic Node service speaking GraphQL over HTTP against Postgres — not a library
you compose, a stack you adopt.

## When & why to use

- You need a **working admin UI** + schema-as-code + Postgres migrations out of the box.
- **Row/field-level ACL** matters (author-only rows, role-hidden fields) — predicates baked into the query layer.
- **Multi-tenant + member roles** (per-project teams, invites) — the tenant API gives it free.
- You can run a **standalone Node backend** with a managed Postgres.

## When NOT to use

- You're committed to **Cloudflare Workers + D1** — Contember's engine is a Node service on Postgres; it does **not** run on Workers (this is the big architectural fork vs the cf-* stacks).
- You need a headless-only API with no React/admin → roll a thinner GraphQL layer yourself, or use `kvalt`.
- Bespoke SQL / aggregations the generated GraphQL fights.

## Impacts (what adopting it forces)

- **Postgres** as the relational store (so `d1` is out — see the `relational-db` slot). You run/manage Postgres.
- A **Node backend service** separate from any Workers SSR frontend — the deployment shape differs from cf-lightweight/cf-fat.
- **Schema is code**; migrations are diff-generated TypeScript committed under `.contember/migrations/`. Regenerate the snapshot whenever you add one or fresh DBs drift.
- A **projects/memberships** model (tenancy) even for single-tenant apps.
- The admin UI + data binding are **React 19** (see `bindx` / `@contember/react-binding`).

## Gotchas

- **ACL is per-field predicates**, declared on the entity (`@c.Allow(role, { when, read, … })`) and injected into SQL — not per-resolver. Complex scoping needs entity variables.
- **Tenant API owns identity** — custom auth (SAML, external JWT, machine principals) means bridging it, not swapping it.
- **No built-in realtime** — admin uses HTTP GraphQL; live updates need your own WS/polling.
- Migrations are diff-generated; hand-editing one (e.g. a data backfill) drops you into the migration format's internals.

## Relationships — why

- **requires `postgres`** — the entire schema/migration/ACL story is Postgres-specific (transitively excludes `d1`, same `relational-db` slot).
- **recommends `react` + `bindx`** — the admin UI and data binding are React; `bindx`/`@contember/react-binding` is the typed binding layer over its GraphQL API.
- **slot `backend`** — the backend choice (one backend per app). It also subsumes auth/identity, so it overlaps `auth-password-kv`/`fabrika-iam` conceptually — if Contember owns tenancy, don't double up.
