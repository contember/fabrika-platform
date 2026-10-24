---
id: 220
title: The provider conformance suite checks no checkpoint size, and Zerops' harness hands no upload bearer
blocked-by: []
---

# 220 — The provider conformance suite checks no checkpoint size, and Zerops' harness hands no upload bearer

**Summary.** Two gaps in `@fabrika/provider-contract/conformance`. Low: both providers' checkpoints are a few fields,
and Zerops' own tests cover the bearer.

## Problem

- Control refuses a provider checkpoint over 16 KiB (`serializeProviderJson`, `packages/control/src/db/runs.ts`). The
  suite only checks that a checkpoint survives JSON, so a provider whose checkpoint grows past the limit passes it
  and fails its first real run.
- The suite's credential check covers `artifactUpload.bearer` only when the harness's input carries one. Cloudflare's
  does; Zerops' (`packages/provider-zerops/src/__tests__/control.test.ts`) does not, though Zerops writes the bearer as
  a service variable.

## Approach / acceptance

- The suite refuses a recorded state over the limit Control enforces, read from one shared constant (it lives in
  Control today; move it to `@fabrika/provider-contract` beside `JsonValue`).
- Zerops' harness input carries an `artifactUpload`, and the suite still passes.

## Touch points

`packages/provider-contract/src/conformance.ts`, `packages/control/src/db/runs.ts`,
`packages/provider-zerops/src/__tests__/control.test.ts`.

<!-- Origin: the WU4 review in docs/sprints/sprint-2026-10-23-provider-neutral-core.md. -->
