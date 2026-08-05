---
id: 0024
title: Retire the legacy environment-name fallback; canonical names only
status: accepted
date: 2026-08-05
---

# 0024 — Retire the legacy environment-name fallback; canonical names only

## Context

[ADR-0018](0018-canonical-fabrika-environment-names.md) renamed every configuration
variable to a plane-qualified `FABRIKA_*` name and, to avoid a flag day, kept the
predecessor name readable at every configuration boundary: canonical wins, legacy
answers with a value-free deprecation warning, and a process warns once per legacy
name. It deliberately did not set a removal release, because at the time the cost of
a coordinated operational migration was not justified.

That reasoning rested on installations whose CI, Cloudflare, and Zerops environments
still carried the old names. There are none. fabrika-platform is pre-release and owes
no backward compatibility to any deployment; the repo's standing direction is that a
superseded decision must not linger as if it were live.

What the window actually bought was carried in the code: about 198 `VOZKA_*` /
`PROPUSTKA_*` / legacy `ZEROPS_*` occurrences across runtime composition roots,
authoring configs, installer resume reads, deploy scripts, the runner job contract,
examples, and the tests that pinned all four precedence cases. Every one of them read
as live configuration. Worse, the mechanism itself — `environmentAliases`, a generic
"read the canonical name or the legacy one and warn" reader exported from
`@fabrika/platform` — is the kind of utility a future rename adopts instead of doing
the rename, and each new reader has to re-implement the same precedence.

Two facts made removal safe rather than merely desirable. First, nothing outside this
repository sets the old names: the generated `zerops.yaml` and the scaffolded GitHub
Actions workflow already emitted canonical names only, and both have tests asserting
that no `PROPUSTKA_`/`VOZKA_` string appears in them. Second, the fallback was pure
input widening — no canonical name changed, no value changed, and no persisted data
records which name a value arrived under. Deleting a fallback can therefore only
narrow what a misconfigured environment is forgiven for, and a name it no longer
forgives fails the BOOT loudly, naming the canonical variable.

## Decision

We will read only canonical `FABRIKA_*` environment names. The legacy fallback and
the machinery that implemented it are removed:

- every `VOZKA_*`, `PROPUSTKA_*`, and legacy `ZEROPS_*` name is deleted from readers,
  type declarations, authoring configs, scripts, examples, and tests;
- `@fabrika/platform`'s `environment.ts` — `createEnvironmentAliasReader`,
  `environmentAliases`, and their types — is deleted, together with the per-package
  wrappers built on it (`sharedSecret`/`booleanAlias`/`requiredAlias` in IAM,
  `optionalAlias`/`requiredAlias` in Control and Operations, `alias`/`requiredAlias`
  in the Zerops control composition, `legacyEnvironmentName` in the Cloudflare
  provider CLI, `readResumeEnvironmentAlias` in the Cloudflare installer,
  `envAliasValue` in the local stack, and the alias readers in the deploy scripts);
- the deprecation-warning path goes with it. There is no runtime warning about
  configuration names any more, because there is no name to warn about;
- `CloudflareRunnerJob.credentials` accepts only `FABRIKA_IAM_URL` and
  `FABRIKA_IAM_PROVISIONING_KEY`. A job is built and consumed within one deploy, so
  no in-flight job can carry the retired keys across this change.

**Invariant: a configuration name has exactly one spelling.** A future rename is a
rename — change the writers and the readers together — not a second accepted spelling
behind a compatibility reader. Reintroducing a generic canonical-or-legacy utility
requires a superseding decision.

ADR-0018's naming rules survive unchanged: the plane-qualified `FABRIKA_CONTROL_*` /
`FABRIKA_IAM_*` families, `FABRIKA_APP_ID` for the consuming application,
`FABRIKA_RUNNER_WORKSPACE` for the runner's filesystem path, and `FABRIKA_ZEROPS_*`
because Zerops reserves the bare `ZEROPS_` prefix and refuses to store a custom
variable using it. Only the transitional half of that decision is retired.

**The durable-identifier distinction from ADR-0018 survives in full.** Identifiers
that contain `vozka` or `propustka` in their VALUES address deployed resources or
persisted data and are NOT configuration branding. Registered app ids (`vozka`,
`propustka`), Worker names (`vozka`, `propustka-worker`, `vozka-runner`,
`vozka-proxy`), D1 database names (`vozka`, `propustka`), the `vozka-run-logs`
bucket, the `vozka-deploy` queue, the `vozka-deploy-runner` container application,
committed Durable Object migration tags, Postgres migration bundle names, ledger
tables, and advisory lock identifiers all stay exactly as they are. Changing one of
those is a migration with its own plan, and it must not ride along with a naming
sweep — which is precisely why this ADR is a sweep and nothing more.

## Consequences

- One name per setting. Reading a composition root no longer means deciding which of
  two spellings the deployment actually used.
- A deployment that still carries a retired name fails at boot with
  `<CANONICAL_NAME> is required`, instead of starting on a value the operator did not
  realise was still in force. For an optional setting it silently reverts to the
  documented default, which is the same failure mode as never having set it.
- `@fabrika/auth`, `@fabrika/provider-cloudflare`, `@fabrika/installation-cloudflare`,
  `@fabrika/local-stack`, and `@fabrika/runner-container` no longer depend on
  `@fabrika/platform` at all; the alias reader was their only use of it. The
  app-facing SDK in particular now pulls in nothing but `@fabrika/auth-core` and
  `jose`.
- Tests that pinned the four precedence cases (canonical-only, legacy-only, both,
  neither) collapse to the canonical case plus the "neither" failure, which still
  asserts that the error names the canonical variable.
- Removing a fallback is irreversible in practice: an installation that had been
  running on a legacy name must set the canonical one before it starts again. That is
  a deliberate one-way door, taken while there is no such installation.
- ADR-0018's observation that "a raw search for legacy words is not sufficient to
  prove completion" stops being true for names and stays true for values. A repo-wide
  search for `VOZKA_`/`PROPUSTKA_` now returns only the exported constant
  `VOZKA_APP_ID` (a TypeScript symbol whose value is the durable app id `vozka`) and
  two guard assertions proving the generated `zerops.yaml` and the scaffolded workflow
  contain no such string.

## Alternatives considered

### Keep the fallback and announce a removal release

This is what ADR-0018 planned. It presumes a fleet whose environments are outside the
repository and must be migrated on a schedule. There is no such fleet, so the schedule
would only be a reason to defer the deletion again — and the cost of the sweep grows
with every composition root added.

### Delete the legacy names but keep `environmentAliases` as a general utility

The reader would have no callers, which is exactly the condition under which a helper
gets re-adopted for the next rename instead of the rename being done properly. A
dead generic is worse than no generic: it looks endorsed.

### Rename the durable identifiers in the same change

Tempting while sweeping, and wrong for the same reason ADR-0018 gave: several of them
are adoption keys or migration history, and renaming them risks duplicate resources,
lost bindings, or disconnected data. It needs its own plan and its own verification
against a live installation.
