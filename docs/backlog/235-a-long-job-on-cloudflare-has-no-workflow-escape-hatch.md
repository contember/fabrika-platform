---
id: 235
title: A long job on Cloudflare has no Workflow escape hatch
blocked-by: []
---

# 235 — A long job on Cloudflare has no Workflow escape hatch

**Summary.** On Cloudflare a job runs in 14-minute segments and chunks itself through claims. A contract-declared
Cloudflare Workflow, generated into the entry, would let one job run longer without that chunking. Effort: L.

## Problem

The application object runs a job inside an alarm or a request, so one segment is bounded at 14 minutes. Unit 5.6 of
the application object sprint refuses a longer `timeoutMs` from the gated release on. A job that cannot be split into
idempotent claims, such as one long external export, has no supported form on Cloudflare. The pinned generated entry
(unit 1.6) refuses an authored `workflows` binding, so the author cannot add a Workflow alone.

## Approach / acceptance

The owner decided to plan this escape hatch on 2026-10-24 (sprint decision Q5); segments remain the default.

- The contract declares a job as `durable` (name open). The framework generates a Workflow class into the entry and the
  `workflows` binding into the generated config, and the bounds admit exactly that binding.
- Each Workflow step runs one segment through the same job runner, under the job's lease, so a run is visible and
  fenced like any other run.
- The checker explains when to use it: only for a job that cannot chunk through claims.
- Witness: a generated Workflow job runs past one segment on Lopata, or on a live account if Lopata cannot run
  Workflows. A redeploy at an older pin generates no Workflow.

## Touch points

`packages/app` (contract kinds, the generated entry, the job runner), `packages/provider-cloudflare` (`bounds.ts`, the
generated config), `packages/check`, ADR-0065 §5.

<!-- Origin: ../sprints/sprint-2026-10-24-application-object.md, decision Q5. -->
