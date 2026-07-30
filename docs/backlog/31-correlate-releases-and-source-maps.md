---
id: 31
title: Correlate errors with deploy releases and source maps
blocked-by: [./28-model-observed-app-environments.md, ./30-provision-error-ingest.md]
---

# 31 — Correlate errors with deploy releases and source maps

**Summary.** Make a Fabrika deploy run the source of release identity and connect
new errors and regressions to the change that introduced them.

## Problem

Poplach accepts release values from events and exposes an open source-map upload
endpoint. Fabrika separately knows the deploy run, commit, provider result, and
target environment. Without one release contract, errors cannot reliably answer
which deployment introduced them, and source maps can be missing, overwritten,
or uploaded by an unauthenticated caller.

## Approach / acceptance

- Define a stable release identity derived from the application environment,
  deploy run, and immutable source revision.
- Register the release before or during deployment and record its provider
  acceptance and terminal state.
- Upload source maps and other error-decoding artefacts through an authenticated
  deploy path; remove the open upload surface.
- Stamp or inject release context so ingested events resolve to the same identity.
- Show introduced issues, regressions, error volume, and linked deploy run on
  release and issue views.
- Prove retry-safe registration and upload, correct correlation across successive
  deploys, source-map isolation between environments, and useful behaviour when
  an application omits release context.

## Touch points

- Operations releases, issues, and source-map storage
- `packages/control/` run lifecycle
- `packages/engine/`
- provider deploy implementations
- runner contract and container where artefacts cross that boundary
- Operations and Delivery console routes

<!-- Origin: ../ideas/operations-plane.md and ADR-0016. -->
