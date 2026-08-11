---
id: 63
title: A one-click install from the public repository
blocked-by: []
---

# 63 — A one-click install from the public repository

**Summary.** The second install shape [ADR-0025](../decisions/0025-the-operator-installs-the-platform-fabrika-deploys-apps.md)
commits to: an evaluator gets a running platform without creating a repository or a CI system. Effort M.

## Problem

The sidecar repository (shipped and proven live —
[archive](../archive/sprint-2026-08-07-zerops-from-scratch-install.md)) is the right shape for an
installation that will be maintained, and too much ceremony for someone deciding whether to adopt
fabrika at all. Zerops imports a project from a YAML document, and this repository already
generates and commits those documents — so most of the input exists.

What is missing is everything the document cannot carry:

- **The import establishes no public entry point.** `enableSubdomainAccess: true` is accepted and
  silently dropped; only `PUT /service-stack/{id}/enable-subdomain-access` publishes, and only once a
  service has a DEPLOYED HTTP port. The generated artifacts' headers already say so, which is exactly
  the hand step a one-click install must not have.
- **No secrets, no per-installation values.** ADR-0004 keeps them out of the document deliberately;
  they are written per service through the env API after the services exist.
- **No code.** The provisioning document is `startWithoutCode: true` throughout, so something must
  build the four services afterwards.
- **The proxy manifest and the environment name are written by the deploy, not by the document.** Both
  now have a generator and a command that applies them
  ([archive](../archive/sprint-2026-08-06-zerops-platform-deploy.md)) — this item needs that sequence
  driven from somewhere other than an operator's CI.

So a one-click install is not "apply the committed YAML" — it is the import plus the whole of
`fabrika platform install` + `platform deploy`, driven without a repository.

## Approach

Establish first whether Zerops offers a hosted install trigger that takes a public repository (a
"deploy to Zerops" recipe or button), and what it can run after the import. If it can only import,
the honest one-click is a single command an evaluator pastes — `bunx fabrika platform install …` —
which does the import and then everything else locally against their account. Say which it is in the
README rather than implying a button that does not exist.

For Cloudflare, decide whether a one-click equivalent is worth building at all: the account setup is
larger (runner image, GitHub App) and the sidecar may simply be the only sensible path there.

## Acceptance

A person with a Zerops account and no checkout of this repository reaches a running installation they
can sign in to, and the README's description of how many steps that took is accurate.

## Touch points

`packages/installation-zerops/zerops/generated/`, `packages/cli/`, `README.md`,
`docs/reference/zerops-platform.md`.

<!-- Origin: ADR-0025. -->
