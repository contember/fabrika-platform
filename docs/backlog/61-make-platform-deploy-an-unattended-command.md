---
id: 61
title: Make `fabrika platform deploy` an unattended command
blocked-by: []
---

# 61 — Make `fabrika platform deploy` an unattended command

**Summary.** [ADR-0025](../decisions/0025-the-operator-installs-the-platform-fabrika-deploys-apps.md)
makes this command the public interface an operator's pipeline calls. Today it does not deploy a
Zerops installation at all — the live one was brought to HEAD by hand. Effort L.

## Problem

`packages/installation-zerops/CLAUDE.md` states it plainly: "Real-account `init` and `deploy` remain
unsupported until the installation has been exercised with real credentials." The public command is
`fabrika platform plan`, which validates generated artifacts against Zerops' published schemas — and
those schemas are wrong about six probe durations, so passing them proves less than it appears to.

Bringing `fabrika-test` to HEAD on 2026-08-05 therefore took `zops push` from a laptop, once per
service, in a hand-chosen order. Everything that made that run correct lives in a run log rather than
in code:

- **The order is load-bearing.** IAM, Operations, proxy, then control. Since
  [ADR-0022](../decisions/0022-the-proxy-is-the-only-enforcement-point.md) the application enforces
  nothing, so deploying control at a new version while the old permissive manifest is still live
  leaves `/api/*` open for the length of the deploy.
- **The proxy manifest must be regenerated and applied in the same run** ([58](./58-generate-the-platform-installations-proxy-manifest.md)),
  or enforcement silently describes a previous version of the gate modules.
- **The installation's environment name must be written** ([59](./59-the-live-installation-calls-itself-local.md)).
- **`reconcileSchema` runs for the console's own app id** after control is up, or the return-origin
  registry is empty and no browser can complete a login.

## Approach

Make the command do what the hand run did, in that order, idempotently — a re-run is a redeploy, not
a bring-up. It must:

- take every credential from its environment, never from a prompt, and never log one;
- work for both providers through `@fabrika/installation-contract`, with the provider owning the
  per-service mechanics and the contract owning the order;
- fail closed. A deploy that cannot apply the manifest must not leave the previous manifest in front
  of new code.

Whether the first bring-up (`init`) and a routine redeploy (`deploy`) stay two commands or collapse
into one idempotent command is open — the legacy `vozka platform deploy` was a single idempotent
command and its sidecar README described re-running it as "a safe redeploy".

## Acceptance

A `fabrika-test` installation is deployed to HEAD by this command alone, from a clean environment,
with no `zops` invocation and no hand step — and re-running it changes nothing. An anonymous
`GET /api/*` is refused by the proxy before and after.

## Touch points

`packages/installation-zerops/`, `packages/installation-cloudflare/`,
`packages/installation-contract/`, `packages/cli/`.

<!-- Origin: ADR-0025. The gap it names was found by sprint-2026-08-05-zerops-path-correctness, WU-4. -->
