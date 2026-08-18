---
id: 74
title: Namespace provisioning outlives the request that asked for it
blocked-by: []
---

# 74 — Namespace provisioning outlives the request that asked for it

**Summary.** Creating a namespace is a synchronous HTTP call that takes about five minutes — a project
import, a proxy build, a subdomain publication — so the caller always receives a gateway timeout, and
neither the console nor the CLI can report the outcome. Effort M.

## Problem

`createNamespace` and `reconcileNamespace` run the whole provider mutation inside the request
(`packages/control/src/api/namespaces.ts`). On the live account the first namespace took a project
import (~30 s), a proxy build from git (~4½ min) and a subdomain publication, and every attempt ended
the same way for the caller:

- `502 Bad Gateway` and `504 Gateway Time-out` at the client, with a non-JSON body, so the typed RPC
  client reports a transport fault rather than a result;
- control CONTINUES working after the client is gone — the build it triggered at 15:40:07 kept running
  and finished normally — so the timeout says nothing about whether provisioning succeeded;
- the row is left `failed` whenever control's own wait is cut short, even though the provider made real
  progress and checkpointed it.

The console has the same problem and no way around it: its create form awaits the same call.

Every other long operation in the system is already asynchronous. `triggerDeploy` creates a `pending`
run and enqueues it (`packages/control/src/api/runs.ts:250`), precisely so the trigger is durable even
if delivery is delayed. Namespace provisioning is the odd one out.

## Approach / acceptance

Make provisioning a job like a deploy: the call records the namespace `provisioning` and returns, and
the work runs behind the queue with the checkpoints it already writes. `state` already carries the
progress the UI needs, and the startup reconcile already exists to resume in-flight work.

Note that `failed` must then mean "the provider refused", not "the caller went away" — which is also
what [72](72-a-failed-namespace-reports-nothing-an-operator-can-act-on.md) needs in order to say
anything useful.

Witness: creating a namespace answers in well under a second with `state: provisioning`; polling
reaches `ready` without another client call; killing the client mid-provision changes nothing about
the outcome.

## Touch points

`packages/control/src/api/namespaces.ts`, the run/job queue plumbing in `packages/control/src/run-lifecycle.ts`,
`packages/dashboard/src/routes/namespaces/create.tsx`, `packages/cli/src/control.ts`.

<!-- Origin: found while provisioning the first live app namespace, 2026-08-18. -->
