---
id: 303
title: Approval requests' follow and exactness edges after D8
blocked-by: []
---

# 303 — Approval requests' follow and exactness edges after D8

**Summary.** These are the minor findings of the step 5b review (ADR-0083 §3). They concern interrupted executions
that settle wrongly, per-input edges, an app-wide write before `prod` exists, and test gaps. None of them lets a
non-person change a protected environment without a person. Low severity, about 4–6 agent hours.

## Problem

- **Provider-prepared fields.** The `apps.environments.put` follow (`packages/control/src/approval/requests/kinds/registry.ts`
  `follow`) compares the asked domain, public origin and namespace with the values the provider prepared. On a provider
  whose `prepareRegistration` rewrites them, an interrupted put that landed settles `failed`.
- **Suspend and resume behind a namespace proxy.** An interrupted suspend or resume settles `executed` from the
  registry's record, even when the republish never ran. The proxy then still serves the old state. This is documented
  as a known limit in `docs/reference/security-deployment.md`.
- **Per-input exactness** (`kinds/registry.ts`, `kinds/shared.ts`):
  - `namesSource` requires global `app.manage` even when `repoUrl` or `githubInstallationId` equals the stored value;
  - `appPatch` refuses `defaultBranch: ''` and `repoUrl: ''`, which the RPC schema accepts.
- **App-wide writes before `prod` exists.** An app-wide write (the all-environments layer) while `prod` is not
  registered yet still applies for a non-person. When `prod` is registered, it starts protected and inherits the
  value. The single-environment writes are refused (403).
- **Test gaps.**
  - Not interrupted in any test: `data.start` after its operation was recorded, `data.recover`, `resume` with a
    recorded operation, and a proxied suspend that did not land.
  - Provider-kept secrets are tested on the Zerops-like shape only.
  - `approval-gate-coverage.test.ts` checks that a mutation is listed, and the refusal under a refuse-all policy. It
    does not check that `person` files a request, the all-environments layer, or the exempt reasons. `register` is
    labelled `registry` but excluded.

## Approach / acceptance

- The put's follow relies on the generation and on the fields the provider does not prepare. A test with a provider
  that rewrites the domain settles `executed`.
- A follow or a sweep that finds a suspension recorded without its republish queues the republish. This converges
  stored state and is not a second write. A test interrupts after the record.
- The source check compares with the stored values first. The empty-string cases follow the direct call.
- An app-wide write by a non-person while an environment that starts protected is absent answers 403, as the
  single-environment write does.
- The coverage table gains the `person` → request row and the layer. Each exempt entry names its reason.

## Touch points

- `packages/control/src/approval/requests/kinds/{registry,data,shared}.ts`
- `packages/control/src/approval/requests/route.ts`
- `packages/control/src/__tests__/approval-request-external-kinds.test.ts`
- `packages/control/src/__tests__/approval-gate-coverage.test.ts`

<!-- Origin: the review of step 5b of ../ideas/agent-requested-approvals.md (PR #439, round 1). -->
