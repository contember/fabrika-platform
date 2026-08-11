---
id: 0028
title: Zerops apps own their repository root
status: accepted
date: 2026-08-11
---

# 0028 — Zerops apps own their repository root

## Context

Zerops reads `zerops.yaml` from the root of the Git repository it builds. Its external repository
integration identifies a repository, branch, and `zeropsYamlSetup`. It has no field for a descriptor,
working directory, or path to `zerops.yaml`. The private-repository path therefore cannot deploy an
application whose descriptor lives below its repository root.

The public build trigger can carry an inline descriptor. Using that exception would create two source
models: a subdirectory application could deploy while its repository is public, then become
undeployable when the same repository becomes private. Fabrika must not make repository visibility
change the valid application layout.

## Decision

An application that Fabrika deploys to Zerops is a Git repository whose root owns `zerops.yaml`.
Fabrika will pass the setup name selected by the application config and will not use an inline
descriptor to hide a subdirectory layout.

**Invariant: the `zerops.yaml` used by a Zerops application deploy lives at the root of that
application's Git repository.**

## Consequences

- Public and private repository deploys use the same repository tree and descriptor.
- A Zerops application cannot rely on a descriptor stored only in a parent monorepo or below its own
  repository root.
- Fabrika does not need to synthesize, persist, or reconcile an inline descriptor for application
  deploys.
- The local `examples/zerops-app` workspace fixture is mirrored unchanged into the standalone
  `contember/fabrika-example-zerops` repository with `git subtree split`. This is how this monorepo
  keeps one tested source tree; it is not a required repository-management model for other apps.

## Alternatives considered

**Send an inline descriptor for public builds.** Zerops accepts it on the public trigger, but the
private integration cannot. This would make privacy a breaking layout change.

**Teach Fabrika a repository subdirectory.** The private integration exposes no path or descriptor
field, so Fabrika cannot translate that value into a valid Zerops deployment.

**Remove the example from the monorepo.** A fully separate repository would satisfy Zerops, but this
repository would lose direct typecheck and test coverage. The subtree mirror keeps that coverage while
publishing the exact directory as a repository root.
