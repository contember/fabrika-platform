---
id: 69
title: A Zerops run's build log never reaches the run record
blocked-by: []
---

# 69 — A Zerops run's build log never reaches the run record

**Summary.** The Zerops provider relays a build log faithfully and the control plane drops it into
stdout, so `GET /runs/:id/log` is empty for every Zerops deploy that has ever run. Effort S.

## Problem

The provider does its half. `relayLog` polls `getLogAccess` + `readBuildLog` inside `awaitVersion` and
pushes each line to `env.log` (`packages/provider-zerops/src/provider.ts:92-114`, `:132-142`, `:283`).

The control plane wires that sink to the console:

```ts
// packages/control/src/run-lifecycle.ts:314
log: (line) => console.info(`deploy run ${run.id}: ${line}`),
```

Meanwhile `markRunStarted` stamps `log_key = runs/<id>/logs.ndjson` on the run row
(`packages/control/src/db.ts:892-896`) and the read APIs serve that blob
(`packages/control/src/api/runs.ts:154,176`). Its only writer is the **Cloudflare** runner relay
(`packages/runner-cloudflare/src/relay.ts:114`). Nothing on the Zerops path writes it.

So a Zerops run answers `GET /runs/:id/log` with `{ lines: [] }` and its build log survives only in the
control container's stdout, which is not addressable from the console and does not outlive the
container. The console shows deploy logs on one provider and nothing on the other, with no message
saying why.

No CLAUDE.md, ADR or reference file mentions this, so it reads as an oversight rather than a decision.

## Approach / acceptance

Write the relayed lines to the run's `log_key` object **from the control plane**, so the writer is the
plane that owns the run rather than a provider-specific runner — the Cloudflare relay then becomes one
producer of the same sink instead of the only path to it. Keep the stdout line: it is what still works
when the blob store does not.

Witness: a real Zerops deploy run's `GET /runs/:id/log` returns its build log, and the console renders
it. Against a live run, not a fixture — the fixture is what hid this.

## Touch points

`packages/control/src/run-lifecycle.ts`, `packages/control/src/api/runs.ts`,
`packages/runner-cloudflare/src/relay.ts` (only if the sink is unified).

<!-- Origin: found while scoping sprint-2026-08-11-fabrika-deploys-an-app-on-zerops. -->
