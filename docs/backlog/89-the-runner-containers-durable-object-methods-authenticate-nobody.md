---
id: 89
title: The runner container's Durable Object methods authenticate nobody
blocked-by: []
---

# 89 — The runner container's Durable Object methods authenticate nobody

**Summary.** The security review's fix for H9 keys both RPC methods of the runner Worker
(`startRun`, `cancelRun`) with `FABRIKA_RUNNER_KEY`. The `RunnerContainer` Durable Object class the
same Worker exports runs no such check: another Worker on the account that declares a
`durable_objects` binding with `script_name: <env>-vozka-runner` drives a container directly.
Recorded in the commit message of the fix and nowhere else. Effort S.

## Problem

- `packages/runner-cloudflare/src/worker.ts:23` exports `RunnerContainer`, as a Container DO must be.
- `packages/runner-cloudflare/src/RunnerContainer.ts` — `armBackstop`, `backstopCheck` and the
  inherited `Container` surface (`containerFetch`, `destroy`, and the lifecycle calls) take their
  arguments as given; only the Worker entrypoint verifies the runner key.
- A cross-script DO binding needs no service binding and no key: any Worker in the account that can
  name the class reaches it. Before the authored-graph allowlist, an application config could declare
  exactly that binding from a checkout; after it, the reach is any Worker the account already runs.

## Approach / acceptance

Two options, pick one:

1. Refuse the DO binding at the platform edge: keep the class exported (required) but make every
   externally callable method verify a per-run token the Worker mints when it starts the container,
   so a caller without the `startRun` path holds nothing that unlocks a method.
2. Move the container behind a private interface: the Worker keeps the only `DurableObjectNamespace`
   binding and the DO's methods take an opaque handle the Worker derives from the run id and the
   runner key (HMAC), verified on entry.

Acceptance: a test that calls `armBackstop`/`backstopCheck`/`containerFetch` on a stub with no handle
and asserts a refusal before any container work; the authored-graph test that refuses a
`durable_objects.script_name` naming the runner stays, as the second layer.

## Touch points

- `packages/runner-cloudflare/src/RunnerContainer.ts`, `src/worker.ts`, `src/runner-key.ts`.
- `packages/runner-cloudflare/src/__tests__/`.

<!-- Origin: security review 2026-09-02, finding H9 (A6-4); the cross-script DO twin named in commit 7d6b795 and found unrecorded by the closure validation of 2026-09-03. -->
