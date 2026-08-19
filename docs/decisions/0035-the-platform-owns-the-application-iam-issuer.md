---
id: 0035
title: The platform owns the application's IAM issuer, and an undeclared variable is refused
status: accepted
date: 2026-08-19
---

# 0035 — The platform owns the application's IAM issuer, and an undeclared variable is refused

## Context

The first application deployed into a live Zerops namespace built, migrated, and then exited at every
container start with `FABRIKA_IAM_ISSUER is required`. Nothing in fabrika had written that variable,
and setting it through the control plane — `apps.variables.put`, which the console and the CLI both
offer — was accepted and had no effect. The value was eventually written straight through the Zerops
platform API by hand, which is not a mechanism the platform can be said to have.

Three facts, established by reading both providers rather than assuming symmetry:

**`vars` are an input to CONFIG COMPILATION on both providers, not an application's runtime
environment.** On Cloudflare the runner forwards each `vars` entry into the deploy child's environment
by name (`packages/runner-container/src/runner.ts:238-241`), where the app's `fabrika.config.ts` reads
it and maps it into the Worker's own `vars` — `examples/app/fabrika.config.ts` does exactly that. On
Zerops `compileFabrikaManifest` sets `process.env[NAME]` to the literal `${NAME}` before compiling, and
`interpolateManifest` substitutes the deploy-time value into the IMPORT DOCUMENT
(`packages/provider-zerops/src/provider.ts:74-86`, `:462`). Both are the same idea. Neither writes an
undeclared name anywhere, so a variable an app has not declared in `pipeline.vars` is stored and
silently ignored.

**Cloudflare already receives the issuer from the platform; Zerops has no equivalent.** The Cloudflare
example's config reads `process.env.FABRIKA_IAM_URL`, which the control plane supplies to the deploy,
and maps it to the app-facing `FABRIKA_IAM_ISSUER`. On Zerops, `FABRIKA_IAM_URL` is written only to the
namespace PROXY (`packages/provider-zerops/src/namespace.ts:762-770`) and never to an application
service. The Zerops example's own config states the assumption that was never implemented:
"per-environment configuration reaches a Zerops service as a service-level environment variable
instead."

**The value is not application configuration.** It is the IAM service's public origin: the `iss` of
every token the app verifies and the base of the JWKS it fetches. It is identical for every application
on an installation, the platform is the only thing that knows it, and an app that receives the wrong one
verifies tokens against the wrong issuer. That is the same argument that already put
`FABRIKA_OPERATIONS_DSN` into `managedEnvironment`.

A fourth fact constrains any solution: a name an app declares in its own `zerops.yaml`
`run.envVariables` is `type: ENV` — absent from `/env`, and it makes a user-data `POST` answer
`userDataDuplicateKey` (`docs/reference/zerops-platform.md`). Whatever the platform writes must NOT be
declared in the descriptor, or the platform can never write it.

The name itself was split: `@fabrika/auth`'s `createIam` reads `FABRIKA_IAM_URL`, both proxies read
`FABRIKA_IAM_URL`, and both examples read `FABRIKA_IAM_ISSUER` and translate at the call site. One
value, two names, and the translation step is where an app can quietly point itself at a different
issuer.

## Decision

We will treat the application's IAM issuer as platform-owned configuration, under one name.

1. **`FABRIKA_IAM_ISSUER` is the canonical name**, from the platform's own configuration through to the
   application. `FABRIKA_IAM_URL` is renamed everywhere it appears — `@fabrika/auth`, both proxies,
   both installations, the runner job contract, the authoring configs and the examples. This is a
   flag-day rename with no transitional reader, as [ADR-0024](0024-retire-the-legacy-environment-name-fallback.md)
   requires: a fallback is "the kind of utility a future rename adopts instead of doing the rename".
   The name says what the value IS — the `iss` of a token — rather than where it happens to be fetched
   from.

2. **The control plane delivers it through `managedEnvironment`**, alongside `FABRIKA_RELEASE` and the
   Operations keys. Every provider already writes `managedEnvironment` to the deployed application, so
   both clouds gain it at once and neither gains a special case. An application variable that collides
   with the name is refused at deploy, exactly as the Operations-managed names already are.

3. **A variable the artifact does not declare is refused where it is set**, not stored and ignored.
   `ControlProvider` gains an optional `declaredVariables` hook; a provider that can answer does, and
   `apps.variables.put` refuses a name outside that set. Cloudflare cannot answer — its artifact names
   a config path and the declaration lives in the repository — so Cloudflare constrains nothing, which
   is the honest answer rather than a guess.

## Consequences

An application no longer configures its own issuer, and the worked examples stop carrying a value an
operator had to know. A fresh installation brings up an app with no hand-written service variable,
which is what the install path claimed.

`managedEnvironment` grows a name that is not an Operations concern, so the platform-managed set is no
longer wholly owned by `@fabrika/operations-contract`. The canonical name constant therefore lives in
`@fabrika/auth-core`, which every consumer — `@fabrika/auth`, both proxies, `@fabrika/provider-contract`
and the control plane — already depends on and which depends on nothing.

The rename is operationally disruptive by design. Every running installation carries services whose
environment holds `FABRIKA_IAM_URL`; one `platform deploy` writes the new name and then deploys the code
that reads it, in that order, so the roll is safe but it must actually be performed. A namespace proxy
picks the new name up on its next reconcile.

An app that declares no variables can no longer have one set. That is the point, but it means an
operator who wants a per-environment value must add it to `pipeline.vars` in the app's config, and the
refusal message has to say so.

## Alternatives considered

**Have the Zerops provider write `vars` to the service.** It would make `apps.variables.put` mean what
its name says — but only on Zerops. The same contract field would then be a build-time input on
Cloudflare and a runtime environment on Zerops, which is the opposite of what a provider contract is
for. It also has no clean answer for precedence against the `type: ENV` names the platform cannot write.

**Leave the mechanism alone and have the app declare the issuer in `pipeline.vars`.** This uses what
already exists and needs no contract change, and it was the closest alternative. It loses on two
counts. The value is identical for every app on the installation, so every app would re-declare and
every operator would re-set the same string; and on Zerops it would arrive through the import document,
whose `envSecrets` were measured to be create-only on re-import — leaving it unproven that the value
could ever be CHANGED after the first import.

**Keep both names.** Rejected by ADR-0024, and the translation step is itself where an app can point
itself somewhere else.
