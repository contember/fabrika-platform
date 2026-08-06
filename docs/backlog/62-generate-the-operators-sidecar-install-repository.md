---
id: 62
title: Generate the operator's sidecar install repository
blocked-by: [./61-make-platform-deploy-an-unattended-command.md]
---

# 62 — Generate the operator's sidecar install repository

**Summary.** [ADR-0025](../decisions/0025-the-operator-installs-the-platform-fabrika-deploys-apps.md)
puts the install pipeline in a repository the operator owns. fabrika ships the generator for it, not
the pipeline. Effort M.

## Problem

Nothing produces the caller. `fabrika platform deploy` — once [61](./61-make-platform-deploy-an-unattended-command.md)
makes it real — needs something to invoke it with an account's credentials, and ADR-0025 forbids that
something living in this repository.

## The shape, which already exists in the predecessor

`contember/vozka-platform-mangoweb` is three files and is worth copying rather than redesigning:

- `.github/workflows/platform.yml` — checkout self, read the pinned ref, checkout the public platform
  repository at it, `bun install`, run the platform deploy. `concurrency: platform-deploy` with
  `cancel-in-progress: false`; `push` restricted to paths `[<ref file>, <workflow>]` so a README tweak
  does not redeploy; a `workflow_dispatch` for manual runs.
- `vozka.ref` — one line pinning the platform version. Bump it and push to roll out.
- `README.md` — states that this repository is the per-account root of trust and that the platform
  never deploys itself.

Its secrets and non-secret variables live in a **GitHub Environment** named for the account, written
by `vozka init <account>`, not hand-edited. Note its workaround: GitHub reserves the `GITHUB_` prefix
for Environment secret names, so the App id/key/webhook secret are stored as `GH_*` and mapped in the
workflow's `env:` block.

## Approach

`fabrika platform init` generates and maintains it. Open questions worth settling before building:

- **What differs per provider.** The Cloudflare pipeline needs a runner-image build on first bring-up
  (`--build-runner-image` in the predecessor); Zerops has no runner (ADR-0003) and needs the one-time
  GitHub↔Zerops link instead ([47](./47-give-the-zerops-path-a-private-git-source.md)).
- **How much the CLI is allowed to do to someone's GitHub account.** The predecessor created the
  repository, the GitHub App, and the Environment with its secrets. That is a lot of authority for one
  command; decide what it does versus what it prints for a human to do.
- **Bootstrap and its closure.** The predecessor seeded `VOZKA_BOOTSTRAP_ADMINS` and told the operator
  to set it to `[]` and re-run once a real admin exists. An escape hatch that is documented but never
  closed is [59](./59-the-live-installation-calls-itself-local.md) again — prefer a mechanism that
  closes itself.
- **Pinning by tag, not branch.** ADR-0025 makes published tags load-bearing; the generated pipeline
  should pin a tag and the generator should refuse a branch.

## Acceptance

A generated sidecar repository deploys a fabrika installation to a fresh account with no step taken
inside this repository, and bumping its pinned ref rolls the installation to a new version.

## Touch points

`packages/cli/`, `packages/installation-contract/`, `packages/installation-{cloudflare,zerops}/`.

<!-- Origin: ADR-0025. Reference implementation: contember/vozka-platform-mangoweb. -->
