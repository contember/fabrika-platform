# @fabrika/runner-cloudflare

The Cloudflare deploy executor Worker. It owns the per-run `RunnerContainer` Durable Object and relays
container logs and the terminal status to R2, where Control reads them back. It has
no public route and is called through a service binding — but a binding is not a capability, so it
also holds ONE credential, `FABRIKA_RUNNER_KEY`, and verifies it on every RPC.

The Worker↔container protocol comes from `@fabrika/provider-cloudflare/runner`. The plain-Bun process and Docker
image live in `@fabrika/runner-container`. `CloudflareRunnerJob` remains owned and validated by
`@fabrika/provider-cloudflare`.

## Commands

```bash
bun test
bun run oblaka
bun run bootstrap
```

## Invariants

- **Every RPC method verifies `FABRIKA_RUNNER_KEY` before any side effect** (`src/runner-key.ts`), and
  `startRun` parses the job with `cloudflareRunnerJobSchema` first and consumes its output — RPC delivers a structured clone.
  Any Worker on the account can bind `<env>-vozka-runner`, so "only the control plane holds the
  binding" authenticates nobody. An unset key denies every call; the refusal names nothing.
- **The key stops at this Worker.** The relay strips `runnerKey` from the job it POSTs to the container,
  which runs the checkout's own code as root; `cloudflareRunnerJobSchema` therefore treats it as OPTIONAL.
- **A run's container is addressed ONLY by its keyed name** — `runnerInstanceName(FABRIKA_RUNNER_KEY, runId)`,
  an HMAC in `src/runner-key.ts`. Never call `RUNNER.idFromName` with anything else: any Worker on the
  account can bind the class through a cross-script `durable_objects` binding and address an instance by
  name, so a name it can compute is a real run's container. Every `RunnerContainer` method that names a run
  (`startDeploy`, `recoverDeploy`, `armBackstop`, `backstopCheck`) first checks that this instance IS that
  run's keyed instance (`assertRunnerInstance`), so an instance someone else started cannot persist a real
  run's status or IAM reconcile. Rotate `FABRIKA_RUNNER_KEY` only with no run in flight: an in-flight run's
  container is no longer addressed, and its recovery reads it as never dispatched.
- **That is not "A6-4 closed".** Another Worker can still start instances of its OWN under names it picks
  and drive them (the whole inherited `Container` surface). They run the runner image with no Fabrika
  secret, but they cost money and count against `max_instances`. Backlog 89 records the residual and the
  full fix.
- **Every method of `VozkaRunner` and `RunnerContainer` is RPC-reachable**, TypeScript-private ones
  included (workerd exposes every prototype method). A helper that addresses a container or touches
  storage stays a module function.
- The Worker publishes no hostname of its own: `routes: []`, `workers_dev: false`, `preview_urls: false`.
- Never log credentials or secret values.
- **The Worker never writes Control's database.** Control is the only writer of a run's row (ADR-0044).
  The durable outcome is `runs/<id>/status.json` in R2, carrying the IAM reconcile the executor compiled:
  the relay writes it, the `RunnerContainer` backstop writes it when a Control self-deploy aborted the
  relay, and `recoverRun` reads it back. Without one, `recoverRun` has the run's DO settle it itself
  (`recoverDispatched`): fence a never-dispatched job, persist a terminal container status, or persist
  failed past the deadline counted from the stored dispatch time — so recovery never depends on the
  backstop, whose thrown callbacks `@cloudflare/containers` drops (`backstopTick` reschedules instead).
  A malformed `status.json` reads as failed. The dry-run flag on a persisted status comes from the job
  (relay) or DO storage, never from the container.
- The Worker must stay separate from the control plane so self-deploys cannot reset active runs.
- Each account deployment builds the container from its pinned fabrika checkout. Never restore a
  repository-wide registry tag or an upstream image publisher.
- Keep a 20-minute active rollout grace so runner replacement does not interrupt normal deploys.
- `RUN_LOGS` adopts the control plane's existing R2 bucket. The Worker binds no database.
- `src/index.ts` exports the `VozkaRunner` class as a type only.
- Deploy this Worker out of band. It cannot safely deploy itself through itself.
