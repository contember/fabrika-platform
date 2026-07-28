---
id: 0009
title: A deploy targets a discriminated platform; collaborators belong to the driver, not to deploy()
status: accepted
date: 2026-07-28
---

# 0009 — A deploy targets a discriminated platform; collaborators belong to the driver, not to `deploy()`

## Context

[ADR-0002](0002-deploy-driver-owns-the-plan.md) put plan derivation behind a
`DeployDriver`. Implementing that seam surfaced two things ADR-0002 did not
cover, both of which block the Zerops driver ([ADR-0003](0003-no-deploy-runner-on-zerops.md)).

**1. `DeployRuntime` is Cloudflare-shaped, and it is a parameter of the public
`deploy()`.** Its members are `runCommand` (presumes a shell and a filesystem),
`provision` (takes an oblaka `Definition`), `reconcileSchema` (an HTTP call to
the IAM service), and `log`. ADR-0002 said the runtime "stays where it is, for
what it was for" — a testability seam. But a Zerops deploy is five HTTP calls
with no shell and no filesystem, so a Zerops driver can use **exactly one**
member: `log`. Passing it a bundle whose other three members are meaningless is
not a seam, it is a lie in the type system.

**2. `DeployContext` is Cloudflare-shaped in its _required_ fields.**
`accountId` and `apiToken` are non-optional and `stateNamespace` is a pure
oblaka concept. A Zerops deploy needs a project id, a service id and a Zerops
personal access token, and has no notion of an oblaka state namespace. Today a
Zerops caller would have to invent Cloudflare credentials to satisfy the type.

Both were kept as-is while the driver seam landed, because that work was bound
to strict behaviour-neutrality. That constraint has now been discharged.

## Decision

**The deploy target becomes a discriminated union on `DeployContext`.** The
context keeps what is genuinely universal — `env`, `domain`, `secrets`, `vars`,
`cwd`, `dryRun`, and the IAM coordinates — and moves every platform credential
and platform-specific handle into a discriminated `target` member, keyed by
platform. Cloudflare carries `accountId`, `apiToken` and `stateNamespace`;
Zerops carries its project/service ids and token. A driver reads only its own
variant, and the discriminant is what selects the driver.

**Collaborators move from `deploy()`'s parameter list into the driver's own
construction.** `DeployRuntime` splits:

- the **neutral** part — `log`, and cancellation when it lands — travels with
  the run and is available to every driver;
- the **Cloudflare** part — `runCommand`, `provision`, `reconcileSchema` — is a
  bundle the Cloudflare driver is constructed with, and which its tests
  substitute.

A Zerops driver is constructed with its own collaborator instead (a Zerops API
client), and never sees a `runCommand` it cannot honour.

This is a **breaking change** to `deploy()`'s signature and to `DeployContext`.
That is acceptable: every consumer is inside this repo.

## Consequences

- The testability property survives intact — each driver still has one seam
  where all its side effects live, so dry-run and unit tests work per driver
  rather than globally. Cloudflare's existing fake-runtime tests port directly.
- A driver can no longer be handed collaborators it cannot use, so "which
  members are meaningful here?" stops being tribal knowledge.
- `dryRun` stays on the run rather than in a driver bundle: it is a property of
  the deploy, and every driver must honour it.
- The engine keeps no per-platform knowledge whatsoever — the discriminant is
  data, and driver lookup is a map from it.

## What this does NOT fix

`AppConfig.resources()` still returns an oblaka `Worker`, so the **app-authoring
surface** remains Cloudflare-specific one level above the driver seam. The
Cloudflare driver now owns the call, but a Zerops driver has nothing to call.
[ADR-0005](0005-compile-app-config-to-static-manifest.md) is the planned answer;
until it lands, the driver seam is clean and the config seam is not.

There is also still **no cancellation anywhere in the engine** — no
`AbortSignal`, nothing. ADR-0002 described the engine's residual surface as
"progress reporting, logs, failure handling, and cancellation"; the first three
exist and the fourth does not. A Zerops driver polling `/app-version` needs one,
so the signal belongs on the run alongside `log`.
