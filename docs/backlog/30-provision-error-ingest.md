---
id: 30
title: Provision application error ingest
blocked-by: [./28-model-observed-app-environments.md]
---

# 30 — Provision application error ingest

**Summary.** Give every observed application environment a managed write-only
ingest credential and provider-correct runtime configuration.

## Problem

Poplach project creation currently returns a DSN backed by a locally managed API
key. Fabrika should not require an operator to create another project, copy a
credential, and configure each environment manually. The integration must also
recognize that a Sentry DSN contains a client-visible public key and therefore
cannot rely on secrecy. Abuse resistance must come from source scope, a stored
verifier, payload/rate limits, rotation, and revocation. Raw credentials must
still never appear in logs, plans, or error responses.

## Approach / acceptance

- Define the Sentry-compatible ingest endpoint and credential lifecycle for an
  Operations source.
- Generate caller-side credentials, persist only the verifier in Operations,
  and support rotation and revocation.
- Inject the DSN through the selected provider's supported environment
  configuration during registration or reconciliation. Do not classify
  browser-visible DSN material as a confidential secret.
- Provide an application integration surface that configures supported Sentry
  SDKs without coupling application code to a deployment provider.
- Apply source-scoped rate and payload limits before queueing an event.
- Test Cloudflare and Zerops configuration assembly, rotation, revocation,
  unauthorized ingest, oversized payloads, and credential redaction.

## Touch points

- Operations ingest and credential repositories
- `packages/control/`
- `packages/provider-contract/`
- `packages/provider-cloudflare/`
- `packages/provider-zerops/`
- application-facing Fabrika packages and examples

<!-- Origin: ../ideas/operations-plane.md and ADR-0016. -->
