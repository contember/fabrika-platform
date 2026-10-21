---
id: 198
title: An in-container env write may reach another service's credentials
blocked-by: []
---

# 198 — An in-container env write may reach another service's credentials

**Summary.** Measure whether application code can write its own service variable from inside its container (`zsc`) with a
`${host_KEY}` reference that Zerops then resolves; if it can, a `cheap` namespace's shared PostgreSQL superuser is
reachable by every application in it. Security; a live-account measurement first.

## Problem

A variable written through the env API resolves `${host_KEY}` at container start, across services, whatever
`envIsolation` says (`docs/reference/zerops-platform.md`). Fabrika checks every reference only on its own write paths: the
manifest, `interpolateManifest` and `secrets.put` (`packages/provider-zerops/src/service-references.ts`, `control.ts`). A
container also carries `zsc`, which has write powers (`zsc scale`, ADR-0043). If a command such as
`zsc setSecretEnv X '${postgres_superUserPassword}'` exists and its value resolves after a restart, application code gets
the shared database's superuser, and with it every other application's schema in a `cheap` namespace. The same path would
make any future co-location of applications with the platform unsafe.

## Approach / acceptance

- A row in `packages/provider-zerops/src/__tests__/platform-facts.live.test.ts`: from a runtime container, try every
  in-container way to write the service's own variable with a reference to a sibling service's generated key, restart, and
  read what the process sees. Record the answer in `zerops-platform.md`.
- If it resolves: decide the mitigation (refuse `zsc` in application images is not possible; candidates are a
  per-application database credential that is not a superuser, or `mid`/`full` presets only for untrusted code) and write
  it into ADR-0017 and the guide.

## Touch points

`platform-facts.live.test.ts`, `docs/reference/zerops-platform.md`, possibly ADR-0017 and `guide.md`.

<!-- Origin: the security review of the co-located installation plan (docs/ideas/compact-installation.md). -->
