---
id: 164
title: A job without .handle prints the builder's type
blocked-by: []
---

# 164 — A job without `.handle` prints the builder's type

**Summary.** An RPC endpoint without `.handle(…)` is a one-line type error that names the fix; a job, a webhook, a
link or an export procedure without one prints the builder's whole type. Effort: S–M.

## Problem

`c.rpc` refuses a pending endpoint with "add .handle(…) to deals.get" (kit mistake 18). A cron job left without a
handler in `jobs: { close }` fails with TS2739: `CronBuilder<{ … 6 more … }, "crm.read", "app", Declared<…>>` is
missing `actions, scope, kind, schedule` from `CronJob`. Type errors are agent-facing surface: the fix should be one
line at the site. `serve` refuses every such site at runtime, naming its path, so nothing runs without a handler; only
the diagnostic is wrong.

## Approach / acceptance

- A check on `app.contract`'s `jobs`, `webhooks`, link and export sections, as `MountPrefix` and the RPC mount do,
  naming `<section>.<name>` and `.handle(…)` in at most two lines.
- Witness: kit mistakes for a job, a webhook and a link procedure without `.handle`, in `kit-types.test.ts`; the
  `kit-scale` budget holds.

## Touch points

`packages/app/src/contract/{kit.ts,group.ts}`, `packages/app/src/__tests__/{kit-types.test.ts,kit-mistakes/}`.

<!-- Origin: the paved-road sprint, WU4 run log ("the GroupBuild gap is closed in serve, not in c.rpc"). -->
