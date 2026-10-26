---
id: 238
title: A renamed application Worker starts with an empty object
blocked-by: []
---

# 238 — A renamed application Worker starts with an empty object

**Summary.** A Cloudflare environment whose application Worker changes its name gets a new, empty Durable Object, and
nothing refuses the change; a guard in Control or the deployer that refuses it once the environment holds an object.

## Problem

From framework 0.9 an application environment on Cloudflare keeps its data in one Durable Object
([ADR-0065](../decisions/0065-an-application-on-cloudflare-runs-in-one-durable-object-per-environment.md)), bound in
the application Worker. A Durable Object namespace belongs to the Worker script that declares its class, so a Worker of
another name binds a new namespace whose database starts empty.

`defineApp` of `@fabrika/provider-cloudflare` names the application Worker after the app id when the config writes no
`resources` (`packages/provider-cloudflare/src/authoring.ts`). An environment already deployed from a config whose
`resources` named the Worker otherwise (the example application was `propustka-example-app`) and that switches to the
short form deploys a new Worker `<env>-<app>`: the proxy's `APP` binding moves to it, and the application serves from
an empty object. The old Worker and its object stay, unreachable. Nothing compares the Worker name with the one the
environment last deployed: not the deployer (`createCloudflareDeployer`, `src/provider.ts`), not its bounds
(`src/bounds.ts`), not Control. The migration guide (`docs/reference/framework-migrations.md`, 0.8 → 0.9) only tells
the author to keep `resources`.

A Worker of framework 0.8 or older is stateless (no `FABRIKA_APPLICATION` binding): renaming it loses no application
data, so the guard concerns only an environment whose last deployed release runs in the object (`runsInObject`).

## Approach / acceptance

Record the application Worker's remote name per environment when a deploy of an object release succeeds, and refuse a
later deploy whose application Worker has another name, before any provider effect, with a message that names both and
the fix (keep `resources` with the old name). An environment without a recorded name, or whose last deployed release
is stateless, deploys as it does today. Where the record lives (Control's registry, handed to the runner like
`applicationObjects`, or the deployer reading the deployed proxy's `APP` binding) is part of the work; a change to the
runner job is a protocol addition (ADR-0062).

Witness: a deploy of an object release under a new Worker name, after one under the old name succeeded, fails before
`provision-resources`; the same rename after a stateless release succeeds.

## Touch points

`packages/provider-cloudflare/src/provider.ts`, `src/control.ts`, `src/runner-protocol.ts`; `packages/control`
(registry, deploy input); `docs/reference/framework-migrations.md`.

<!-- Origin: review of PR #68 (a Cloudflare application's config without boilerplate). -->
