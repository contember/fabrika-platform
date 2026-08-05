---
id: 58
title: Generate the platform installation's proxy manifest
blocked-by: []
---

# 58 — Generate the platform installation's proxy manifest

**Summary.** Two manifest generators exist and neither covers a deployed platform installation, so
the live one is hand-written and drifts silently from the gate modules that own it. Effort S–M.

## Problem

`FABRIKA_PROXY_MANIFEST_JSON` on a platform installation's `proxy` service is the whole of the
enforcement configuration for IAM, the console and Operations. Nothing generates it:

- `compileNamespaceProxyManifest` (`packages/control/src/node/zerops-proxy.ts`) builds an **app**
  namespace's manifest from the control registry — it reads `app_envs` rows and requires a
  `manifest.target.proxy`, which the platform's own services do not have.
- `localPlatformProxyManifest` (`packages/local-stack/src/prepare.ts`) builds the **local**
  composition's, with `*.fabrika.localhost` hosts and `scheme: 'http'` hard-coded.

So the live document on `fabrika-test` was written by hand during the 2026-08-03 bring-up. Measured
2026-08-05: it still gated the control plane as a single `{ path: '/*', kind: 'public' }` while
`CONTROL_PROXY_GATES` had declared fourteen `human`/`service` rules since `2c89ab9`. Nothing reported
the difference — not `local:smoke`, not a test, not a deploy. The console could not sign in at all (a
`public` gate mints no token) and the only thing refusing an anonymous `GET /api/namespaces` was the
application, which ADR-0022 forbids and which the SDK no longer does.

The other three apps in that document (`iam-local`, `operations`, `notes`) happened to match HEAD, so
the drift was one app wide — but nothing made that a fact rather than luck.

## Approach / acceptance

Give the installation packages the third generator, beside the topology they already own: a function
that takes the installation's hosts and emits the manifest from `CONTROL_PROXY_GATES`,
`OPERATIONS_PROXY_GATES` and IAM's own `public` rule — the same imports `localPlatformProxyManifest`
makes, so a gate change reaches a deployed installation the way it reaches the local stack.

Witness: a test that pins the generated manifest's app ids and hosts against the installation
topology's listener list (the local stack's `app-registration.test.ts` is the shape), plus a
`--check`-style comparison an operator can run against a live service's variable to see drift before
it matters.

## Touch points

`packages/installation-zerops/zerops/`, `packages/installation-cloudflare/`,
`packages/local-stack/src/prepare.ts` (the local one becomes a caller, not a copy),
`docs/reference/zerops-platform.md`.

<!-- Origin: sprint-2026-08-05-zerops-path-correctness.md, WU-4 run log. -->
