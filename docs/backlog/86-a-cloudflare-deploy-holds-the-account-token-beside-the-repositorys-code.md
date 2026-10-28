---
id: 86
title: A Cloudflare deploy holds the account token beside the repository's code
blocked-by: []
---

# 86 — A Cloudflare deploy holds the account token beside the repository's code

**Summary.** The Cloudflare path imports the checkout's `fabrika.config.ts` inside the runner
container and then provisions and deploys the resulting graph with the installation's single
account-wide `CLOUDFLARE_API_TOKEN`. That is the design [ADR-0005](../decisions/0005-compile-app-config-to-static-manifest.md)
refused, including its explicitly rejected alternative "execute it in the deploy runner". The
security review mitigated it structurally; the boundary itself is still owed, and so is an ADR that
reconciles the shipped path with ADR-0005. Effort L.

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

What is still open:

- The config module runs in the credential-bearing process. Code at import time can read
  `process.env.CLOUDFLARE_API_TOKEN`, reassign `globalThis.fetch`, or drive the Cloudflare API
  itself; the graph checks bound what the config _declares_, not what it _does_.
- The token is account-wide. A Cloudflare API token can be limited to an account and to zones, not
  to one Worker or one D1 database, so token scoping alone cannot express a per-app boundary.
- A non-platform name that belongs to another app is refused only by a naming rule: Control sends its
  registry of Cloudflare deployments, and a remote name under another app's `${env}-${app}` prefix is
  refused (ADR-0048). An app whose resources are not named under its own id is not protected by it;
  it is still not an ownership record.
- An application's vault secret or variable shares the executor's environment with the run's credentials, by name.
  The deployer refuses `CLOUDFLARE_API_TOKEN` in `pipeline.secrets` and `pipeline.vars`, so `sync-secrets` cannot copy
  the installation's token into the Worker. But Control still resolves every secret and variable of the environment into
  the job, and the runner's `deployEnv` writes them after `job.credentials`: an application secret named
  `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` or `CLOUDFLARE_STATE_NAMESPACE` replaces the platform's value in the
  executor. Control should refuse those names as it refuses `FABRIKA_*` (`assertUnmanagedNames`), and the runner should
  write the credentials last.
- The bound is a name rule, not an account fact. The suffix rule refuses a legitimate app name that
  ends in a platform name (`crm-operations`), because without the platform's own env the two are
  indistinguishable; an ownership record makes the rule exact and lifts that refusal.

## Approach / acceptance

Two parts, in this order.

1. **Decide, in an ADR, how the Cloudflare path relates to ADR-0005.** Either the Cloudflare deploy
   moves config evaluation into the app's own build (`fabrika build` → `fabrika.manifest.json`,
   consumed by the runner with no `import` of app code) and ADR-0005 stands as written, or the runner
   execution is accepted with a stated boundary and the ADR supersedes the part of ADR-0005 that
   rejected it. The ADR names which of the three open points each choice closes.
2. **Give a Cloudflare app an ownership record before provisioning.** Add the `namespaces`
   capability to the Cloudflare control provider so ADR-0014's claims run there: a provider-owned
   name prefix per app plus a route and zone allowlist, validated against the authored graph in
   `open()` before `provision-resources`. If the ADR keeps runner execution, also mint the run's
   credential per app where the Cloudflare API allows it (zone-limited, minimal permission set) and
   pass that in `job.credentials` instead of the installation token.

Acceptance: a provider test in which a config from app A names a resource claimed by app B fails
`open()` before any command runs; a live run on a throwaway account shows the container's environment
holds no credential the run's app does not own; ADR-0005's status line points at the new ADR.

## Touch points

- `packages/provider-cloudflare/src/{provider,plan,control,command}.ts` — claims in `open()`, the
  `namespaces` capability, per-run credentials.
- `packages/control/src/platform-cf.ts` — where the installation token is composed into the job.
- `packages/runner-container/src/runner.ts` — the process that imports the config.
- `docs/decisions/` — the reconciling ADR; `docs/decisions/0005-*.md` status line.

<!-- Origin: security review 2026-09-02, finding C3 (A6-2); the user chose "mitigate now, design later". -->
