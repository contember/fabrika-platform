---
id: 86
title: A Cloudflare deploy holds the account token beside the repository's code
blocked-by: []
---

# 86 — A Cloudflare deploy holds the account token beside the repository's code

**Summary.** Part 1 is done: [ADR-0086](../decisions/0086-a-cloudflare-deploy-builds-without-credentials-and-deploys-without-repository-code.md)
splits a Cloudflare deploy into a build in the runner's sandbox (its own user, no credential, no secret, no network
after the install where the container allows) and a deploy that reads the build's manifest and uploads its bundle
without running any of the checkout's code; ADR-0005 stands. What remains is part 2: the deploy still holds the
installation's account-wide `CLOUDFLARE_API_TOKEN`, and no Cloudflare app owns its resource names. Effort M.

## Problem

`@fabrika/provider-cloudflare` evaluates the app's config with a dynamic `import` in the same process
that holds the Cloudflare account credential, and oblaka resolves every resource to the account-global
name `${env}-${name}` and adopts an existing one by that name. Nothing on Cloudflare makes an app own
its names: `createCloudflareControlProvider` exposes no `namespaces` capability, so the
[ADR-0014](../decisions/0014-provider-owned-deployment-namespaces.md) claim check never runs there.

What the review fixed (commit series of 2026-09-02): `job.credentials` is exactly the account id and
token and nothing else, the `pipeline.build` child runs with those names removed from its
environment, the authored graph is bounded before any Cloudflare call (since B8, on the wrangler configs oblaka generates: `assertGeneration`), and the
runner Worker authenticates its caller. The closure validation of 2026-09-03 found the graph bound
bypassable twice — raw wrangler keys on `Worker.options` (`services`, `durable_objects`, `r2_buckets`,
`build`) were never inspected, and an env named `prod-propustka` with a Worker named `worker` adopted
`prod-propustka-worker` — and tightened it: every Worker the graph reaches may carry only an allowlist
of raw option keys, and the ADOPTED name `${env}-${name}` of every resource is refused when it equals
or ends with a platform name. Those close the cheapest routes — a build line that calls `wrangler`
with the inherited token, a config that adopts or binds `vozka` or `propustka-worker` under any
env/name split, a route in front of another app's proxy.

Closed by ADR-0086: the config module, `pipeline.build`, the checks and the bundler no longer run in the
credential-bearing process; they run as the build user, which cannot read the executor's environment, and the deploy
rebuilds the graph from validated data.

What is still open:

- The token is account-wide. A Cloudflare API token can be limited to an account and to zones, not
  to one Worker or one D1 database, so token scoping alone cannot express a per-app boundary.
- A non-platform name that belongs to another app is refused only by a naming rule: Control sends its
  registry of Cloudflare deployments, and a remote name under another app's `${env}-${app}` prefix is
  refused (ADR-0048). An app whose resources are not named under its own id is not protected by it;
  it is still not an ownership record.
- The bound is a name rule, not an account fact. The suffix rule refuses a legitimate app name that
  ends in a platform name (`crm-operations`), because without the platform's own env the two are
  indistinguishable; an ownership record makes the rule exact and lifts that refusal.

## Approach / acceptance

Two parts, in this order.

1. **Decided and built: ADR-0086.** The config is evaluated in the build sandbox and the deploy consumes its
   manifest; ADR-0005 stands. Still to verify on a live Cloudflare container: that it allows a network namespace (the
   run log says `Build network: none` or `open`) and that a deploy of a real application succeeds end to end.
2. **Give a Cloudflare app an ownership record before provisioning.** Add the `namespaces`
   capability to the Cloudflare control provider so ADR-0014's claims run there: a provider-owned
   name prefix per app plus a route and zone allowlist, validated against the authored graph in
   `open()` before `provision-resources`. Mint the run's credential per app where the Cloudflare API allows it
   (zone-limited, minimal permission set) and pass that in `job.credentials` instead of the installation token; ADR-0086
   records why a separate account per environment needs an IAM reachable across accounts first.

Acceptance: a provider test in which a config from app A names a resource claimed by app B fails
`open()` before any command runs; a live run on a throwaway account shows the container's environment
holds no credential the run's app does not own.

## Touch points

- `packages/provider-cloudflare/src/{provider,plan,control,command}.ts` — claims in `open()`, the
  `namespaces` capability, per-run credentials.
- `packages/control/src/platform-cf.ts` — where the installation token is composed into the job.
- `packages/runner-container/src/runner.ts` — the build sandbox and the deploy (ADR-0086).

<!-- Origin: security review 2026-09-02, finding C3 (A6-2); the user chose "mitigate now, design later". -->
