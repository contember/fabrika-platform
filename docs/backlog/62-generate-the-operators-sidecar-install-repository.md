---
id: 62
title: Generate the operator's sidecar install repository
blocked-by: [./25-bootstrap-npm-trusted-publishing.md]
---

# 62 — Generate the operator's sidecar install repository

**Summary.** [ADR-0025](../decisions/0025-the-operator-installs-the-platform-fabrika-deploys-apps.md)
puts the install pipeline in a repository the operator owns. fabrika ships the generator for it, not
the pipeline. **The generator now exists on both providers**; what is left is proving it against a
real account, and the fresh-account bring-up it deliberately does not cover. Effort S, plus one
genuinely unbuilt piece.

## What shipped

- **Cloudflare** — `packages/installation-cloudflare/src/{scaffold,init}.ts` and `src/templates/`
  already produced the vozka three-file shape before this item was written. The item's original
  premise, "nothing produces the caller", was false when filed.
- **Zerops** — `fabrika platform init --provider=zerops <installation>`
  (`packages/installation-zerops/src/{init,sidecar}.ts`, `a820ac9`). One workflow step, because
  [ADR-0027](../decisions/0027-platform-deploy-is-as-wide-as-the-provider-needs.md) put the deploy
  order inside the command; a `dry_run` input; a push trigger narrowed to the ref file and the
  workflow itself.
- **The shared mechanics** — `@fabrika/installation-init`, the 22nd public package: hidden secret
  prompt, shell rules that never log a child env, the `gh` wrapper, the GitHub Environment write, and
  a generic sidecar scaffold. The FLOW is not shared and should not become shared (ADR-0027).
- **The four questions this item raised** are answered: what differs per provider (the flow, not the
  mechanics); how much authority the CLI takes (everything, confirming before each outward step);
  bootstrap closure (**answered on Zerops by having no hatch at all** — see below); tag pinning (a
  published tag, refused twice, by `assertPinnedTag` and again in the generated workflow).

Bootstrap closure did NOT generalise. Zerops needs no admission list because its `platform deploy`
writes no credential; the Cloudflare path still opens the hatch and trusts the operator to close it
(`installation-cloudflare/src/init.ts:522-524`). That residue is
[64](./64-close-the-bootstrap-admission-hatch-automatically.md).

## What remains

**1. The live acceptance, which has never run.** Everything above is verified by unit tests against
fake APIs. `init` has never been executed once, against any account. Blocked in order on:

- a published `v[0-9]*` tag — the generated workflow refuses a branch, and `release.yml` triggers on
  `v*`, so the first tag also runs the release pipeline. Settled 2026-08-07: do
  [25](./25-bootstrap-npm-trusted-publishing.md) first;
- the operator's two credentials (a Zerops **integration** token and the `px_` provisioning key),
  which live in neither this repository nor a developer's shell;
- a `dry_run` pass before the first real one — the only cheap witness for the environment-write-before-
  deploy ordering and for the proxy-manifest merge, whose failure mode is taking a deployed
  application offline.

**2. A fresh account, which is genuinely unbuilt.** The original acceptance below named one; the
shipped command explicitly covers only an installation that already exists. The obstacle is an
ordering cycle, not an oversight: a proxy that has never deployed publishes no HTTP ports, so
`zeropsSubdomain` names nothing — yet the proxy manifest, which needs those hosts, must be written
before the proxy is built. Breaking that cycle (a two-pass deploy? a placeholder manifest the first
run replaces?) is a design question, not a coding task.

## Acceptance

A generated sidecar repository deploys a fabrika installation **to the existing `fabrika-test`
account** with no step taken inside this repository, and bumping its pinned ref rolls the installation
to a new version. The fresh-account case is explicitly deferred — it needs the cycle above broken
first, and should become its own item once someone has designed the break.

## Touch points

`packages/installation-{cloudflare,zerops}/`, `packages/installation-init/`, `packages/cli/`.

<!-- Origin: ADR-0025. Reference implementation: contember/vozka-platform-mangoweb.
     Largely delivered by sprint-2026-08-06-zerops-platform-deploy (WU4). -->
