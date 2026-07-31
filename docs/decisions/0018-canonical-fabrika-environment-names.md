---
id: 0018
title: Use plane-qualified fabrika environment names with legacy fallback
status: accepted
date: 2026-07-31
---

# 0018 — Use plane-qualified fabrika environment names with legacy fallback

## Context

ADR-0001 merged vozka and propustka into fabrika-platform but deliberately left
their environment-variable names unchanged. Renaming them during the merge would
have broken existing installations, deployment secrets, CI configuration, and
downstream applications in an otherwise behaviour-neutral change.

The legacy prefixes no longer describe the platform structure. `VOZKA_*` mixes
control-plane and runner configuration, while `PROPUSTKA_*` appears both in the
IAM service and in applications that consume IAM. A bare `FABRIKA_*` replacement
would remove the historical names without making ownership clear and could
produce collisions as the Delivery, Access, and Operations planes grow.

The repository also contains durable identifiers with `vozka` and `propustka` in
their values. Those identifiers address deployed resources or persisted data;
they are not environment-variable branding and cannot be swept safely with the
configuration names.

## Decision

New environment-variable names use a fabrika prefix qualified by the component
that owns the configuration:

- `VOZKA_*` becomes `FABRIKA_CONTROL_*`.
- `PROPUSTKA_*` becomes `FABRIKA_IAM_*`.
- `PROPUSTKA_APP_ID` becomes `FABRIKA_APP_ID`, because it identifies the
  consuming application rather than the IAM service.
- `VOZKA_WORKSPACE` becomes `FABRIKA_RUNNER_WORKSPACE`, because the runner owns
  the filesystem path.

The two explicit exceptions take precedence over the prefix rules. Names that
already use a current component prefix, including `OPERATIONS_*`, are outside
this decision.

The migration uses canonical-first dual reads at every configuration boundary:

1. When only the canonical name is set, use it.
2. When only the legacy name is set, use it and emit a deprecation warning.
3. When both are set, use the canonical value. Emit a warning that the legacy
   name was ignored, whether or not the values match.
4. When neither is set, preserve the current required, optional, or default
   behaviour for that setting.

Warnings name variables but never include their values. A process should warn at
most once for each legacy name. Configuration writers, generated files,
installation flows, examples, and new documentation emit only canonical names
after the compatibility layer lands. Readers retain the legacy fallback for a
documented deprecation window. Removing a fallback is a breaking operational
change and requires a later decision with an announced release boundary; this
ADR does not set a removal release.

The compatibility sweep is limited to configuration names. The following
durable identities remain unchanged even though they contain legacy words:

- registered app and infrastructure IDs: `vozka`, `propustka`, and
  `vozka-runner`;
- Cloudflare Worker names: `vozka`, `propustka-worker`, and `vozka-runner`;
- Cloudflare D1 database names: `vozka` and `propustka`;
- the R2 bucket name `vozka-run-logs`;
- the queue name `vozka-deploy`;
- the container application name `vozka-deploy-runner`;
- committed Durable Object migration tags and resource bindings recorded in
  generated `wrangler.jsonc` files;
- Postgres migration bundle names, migration filenames, ledger table names,
  advisory lock identifiers, and the legacy `schema_migrations` evidence
  defined by ADR-0017;
- stored application IDs, provider envelopes, resource claims, object keys,
  queue names, and other persisted values already derived from those IDs.

Changing one of these identities requires a dedicated adoption or data-migration
plan. It must not happen as part of the environment-variable cleanup.

## Consequences

- Operators can move configuration without a flag day. Existing deployments
  continue to start while their legacy names produce actionable warnings.
- New configuration communicates whether Control, IAM, or the runner owns a
  setting.
- Downstream applications receive the same compatibility window as the core
  services for `PROPUSTKA_*` inputs.
- Each runtime and authoring boundary needs the same precedence and warning
  behaviour, with tests for canonical-only, legacy-only, both, and neither.
- Generated configuration changes to canonical names, but deployed resource
  identities and migration history remain stable.
- The repository will temporarily contain both name families in compatibility
  code and tests. A raw search for legacy words is therefore not sufficient to
  prove completion.
- Removing legacy reads remains future work and requires an explicit release
  decision.

## Alternatives considered

### Rename only `VOZKA_*`

This would reduce the immediate downstream blast radius, but it would leave the
public IAM configuration contract under the retired product name indefinitely.
Dual reads provide the needed compatibility without preserving two naming
policies.

### Replace both prefixes with unqualified `FABRIKA_*`

This is shorter, but it hides ownership and increases collision risk between the
three planes and their runtime adapters. Plane-qualified names make composition
boundaries visible.

### Make a hard cutover

A hard cutover is mechanically simpler, but environment and secret names live
outside the repository in CI, Cloudflare, Zerops, and downstream applications.
The resulting coordinated operational migration is not justified when a
deterministic dual-read policy is available.

### Rename deployed resources at the same time

This would make remote dashboards look more consistent, but several names are
adoption keys or migration history. Renaming them risks duplicate resources,
lost bindings, or disconnected data and needs a separate migration plan.
