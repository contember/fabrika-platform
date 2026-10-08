---
id: 89
title: Another Worker on the account can still start its own runner containers
blocked-by: []
---

# 89 — Another Worker on the account can still start its own runner containers

**Summary.** The runner Worker exports the `RunnerContainer` Durable Object class, as a Container DO must
be exported. Any other Worker on the account can bind the class with a cross-script `durable_objects`
binding (`script_name: <env>-vozka-runner`) and call every method of an instance it addresses. The first
fix (option (b) below) closed the reach into REAL runs. What remains: such a Worker can start and drive
instances of its own. Effort M for the full fix.

## What is closed

- **A real run's container cannot be named.** The Worker addresses a run's instance by
  `runnerInstanceName(FABRIKA_RUNNER_KEY, runId)`, an HMAC-SHA256 of the run id
  (`packages/runner-cloudflare/src/runner-key.ts`). Without the key, no name another Worker picks is the
  instance of a real run. Before, the name was the run id itself.
- **An instance cannot act for a run that is not its own.** `startDeploy`, `recoverDeploy`, `armBackstop`
  and `backstopCheck` take a run id in their arguments and persist that run's `runs/<id>/status.json` in
  R2, with the IAM reconcile Control applies. Each one first checks that its own id is the one the run's
  keyed name addresses (`assertRunnerInstance`), before the container, DO storage or R2. Without that
  check, a foreign instance could persist `succeeded` with an IAM schema for any in-flight run of any app,
  and Control's `recoverRun` would read it back and apply that schema to IAM.
- The authored-graph test that refuses a `durable_objects.script_name` naming the runner stays, as the
  second layer against an application config declaring that binding.

## What remains

A Worker already deployed on the account can create instances under names it chooses, and use the whole
inherited `Container` surface on them: `start`, `startAndWaitForPorts`, `containerFetch`, `destroy`,
`schedule`, `deployFetch`, `cancelDeploy`, `heartbeat`, and the TypeScript-private methods, all of which
the Durable Object RPC exposes.

- **What such an instance can reach:** the runner image with only the image's own environment (`PATH`,
  `FABRIKA_RUNNER_WORKSPACE`). `RunnerContainer` sets no `envVars`, and every Fabrika credential reaches a
  container only inside a job the runner Worker posts. So the caller holds no Fabrika secret. It can POST
  a job of its own to `/run`: its own repository and its own Cloudflare credentials, run with internet
  access. It gains compute, not access.
- **What it costs:** container time billed to the account, and slots under the class's `max_instances`
  (3 off-prod, 10 in prod). Filling them makes real deploys fail to start their container.
- **What it cannot do:** reach a real run's container, or persist any real run's status. The DO's R2
  binding is touched only by the methods that name a run, which the instance check guards.

## Why the per-method handle cannot be built on `Container`

The backlog originally offered two options: (1) every externally callable method verifies a per-run token,
or (2) every method takes an HMAC handle and verifies it on entry. Neither can be built while
`RunnerContainer extends Container` from `@cloudflare/containers`:

- workerd's RPC exposes every prototype method except the reserved names `fetch`, `connect`, `alarm`,
  `webSocket*`, `dup` and `constructor`. That includes `Container`'s TypeScript-private methods
  (`startContainerIfNotRunning`, `callOnStop`, `syncPendingStoppedEvents`, `setupMonitorCallbacks`).
  TypeScript does not allow overriding a private member without bypassing the type checker.
- The base class calls its own public methods: `containerFetch` calls `startAndWaitForPorts`,
  `onActivityExpired` calls `stop`, `fetch` calls `containerFetch`, and `alarm` calls `getSchedule`. If
  those methods required a handle, the class's own lifecycle would break.

## Approach / acceptance — the full fix

Option (a): replace `extends Container` with a `DurableObject` of our own that drives `ctx.container`
directly. Its whole prototype is then our own methods, and each one verifies the keyed handle before any
work. The backstop moves onto `ctx.storage` alarms, which the RPC cannot reach (`alarm` is reserved). This
drops the `@cloudflare/containers` dependency, so it is an architecture decision.

Acceptance: a test that calls every method on the class's prototype chain without a valid handle and
asserts a refusal before any container, storage or R2 work.

## Transition note (the keyed-name change)

A run started by a runner Worker from before the keyed-name change lives in an instance named by its run
id. The new Worker does not address that name, and that instance's backstop now refuses its run id.
`recoverRun` reads a persisted `status.json` first, so a run whose relay persisted its status settles
normally. Without one, `recoverRun` reaches the keyed instance, finds no dispatch, and persists the run
failed, even if the old container later finishes the deploy; redeploy that app. A cancel records the run
failed but no longer destroys the old container, which dies within about 15 minutes of the rollout
(SIGTERM, then the hard kill). The Cloudflare installation deploys the runner out of band and before
control, so a run is in flight across that deploy only when someone deployed during the upgrade. Rotating
`FABRIKA_RUNNER_KEY` with a run in flight orphans that run the same way.

## Touch points

- `packages/runner-cloudflare/src/RunnerContainer.ts`, `src/worker.ts`, `src/runner-key.ts`.
- `packages/runner-cloudflare/src/__tests__/`.

<!-- Origin: security review 2026-09-02, finding H9 (A6-4); the cross-script DO twin named in commit 7d6b795 and found unrecorded by the closure validation of 2026-09-03. Narrowed by the keyed instance name (option (b)). -->
