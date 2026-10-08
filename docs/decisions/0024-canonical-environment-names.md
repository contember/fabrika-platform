---
id: 0024
title: Canonical plane-qualified environment names, with no legacy fallback
status: accepted
date: 2026-10-07
---

# 0024 — Canonical plane-qualified environment names, with no legacy fallback

## Context

fabrika-platform grew out of two products, vozka (delivery) and propustka (IAM). Their
`VOZKA_*` and `PROPUSTKA_*` prefixes do not describe the platform's structure. `VOZKA_*`
mixed Control and runner settings. `PROPUSTKA_*` appeared both in the IAM service and in
the applications that consume IAM. A bare `FABRIKA_*` prefix would hide ownership and invite
collisions between the Delivery, Access, and Operations planes.

The platform is pre-release. No installation outside this repository sets a configuration
name, so a compatibility window protects nobody.

Some identifiers contain `vozka` or `propustka` in their values. They address deployed
resources or persisted data. They are not configuration names.

## Decision

Every environment variable uses a `FABRIKA_` prefix qualified by the component that owns
the setting:

- `FABRIKA_CONTROL_*`, `FABRIKA_IAM_*`, `FABRIKA_OPERATIONS_*`, `FABRIKA_PROXY_*`,
  `FABRIKA_RUNNER_*`, and the other per-component families.
- `FABRIKA_APP_ID` identifies the consuming application, not the IAM service. `FABRIKA_IAM_APP_ID`
  is that application's IAM application id `<app>@<env>`, the audience its tokens carry
  ([ADR-0022](0022-the-proxy-is-the-only-enforcement-point.md) rule 6).
- `FABRIKA_RUNNER_WORKSPACE` is the runner's filesystem path.
- `FABRIKA_ZEROPS_*` replaces a bare `ZEROPS_*` prefix, because Zerops reserves that prefix
  and refuses to store a custom variable that uses it.

Readers accept only the canonical name. There is no legacy fallback, no deprecation warning,
and no generic "canonical or legacy" reader. A missing required setting fails at boot with an
error that names the canonical variable.

**Invariant: a configuration name has exactly one spelling.** A rename changes the writers
and the readers together. It never adds a second accepted spelling behind a compatibility
reader.

The naming rules cover configuration names only. These durable identities keep their values,
even when they contain legacy words:

- registered app and infrastructure ids (`vozka`, `propustka`, `vozka-runner`);
- Cloudflare Worker, D1, R2, queue, and container application names (`vozka`,
  `propustka-worker`, `vozka-runner`, `vozka-proxy`, `vozka-run-logs`, `vozka-deploy`,
  `vozka-deploy-runner`);
- Durable Object migration tags and bindings in the committed `wrangler.jsonc` files;
- Postgres migration bundle names, migration filenames, ledger tables, and advisory lock ids
  ([ADR-0017](0017-service-owned-postgres-migrations.md));
- stored application ids, resource claims, object keys, and other persisted values derived
  from those ids.

**Invariant: a naming sweep never renames a durable identity.** Changing one needs its own
adoption or data-migration plan.

## Consequences

- A setting has one name. A reader of a composition root does not need to know which spelling
  a deployment used.
- A deployment that sets only a retired name fails at boot instead of starting on a value the
  operator forgot. An optional setting under a retired name falls back to its default.
- Generated configuration (`zerops.yaml`, the scaffolded GitHub Actions workflow) emits only
  canonical names. Tests assert that no `VOZKA_` or `PROPUSTKA_` string appears in them.
- A repo-wide search for legacy words still finds durable values and the TypeScript constant
  `VOZKA_APP_ID`, whose value is the durable app id `vozka`. A legacy word in a value is not a
  missed rename.

## Alternatives considered

- **Unqualified `FABRIKA_*` names.** Shorter, but it hides ownership and risks collisions
  between planes and runtime adapters.
- **Canonical-first dual reads with a deprecation window.** Protects installations whose
  environments live outside the repository. There are none. The fallback added a shared alias
  reader and four precedence cases to every boundary, and a generic alias reader invites the
  next rename to add a spelling instead of doing the rename.
- **Rename durable identities in the same sweep.** Makes dashboards consistent, but several
  names are adoption keys or migration history. Renaming them risks duplicate resources, lost
  bindings, or disconnected data.
