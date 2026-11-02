---
id: 268
title: opice journeys as a stage gate and production checks
blocked-by: []
---

# 268 — opice journeys as a stage gate and production checks

**Summary.** An application's opice browser tests run after a stage deploy as a condition of the run, and selected
journeys run on a schedule against production as Operations health checks. Large.

## Problem

An HTTP health check proves the process answers, not that sign-in or the main flow works. The builder already plans and
authors opice tests (`packages/builder/shared/phases.ts`, the `opice-plan` and `opice-author` skills), and
`packages/local-stack/src/browser-test.ts` runs them locally, but nothing runs them after a deploy.

## Approach / acceptance

An application declares its journeys (`tests/browser/*.test.ts`). After a stage run succeeds, Control runs them against
the stage URL as a declared workload principal ([ADR-0063](../decisions/0063-a-public-procedure-runs-as-its-own-workload.md))
and records the result on the run and in `get_deployment`; a red journey fails the gate. Selected journeys run against
production as a health check kind beside the HTTP checks (`packages/operations/src/health.ts`); a failure opens an issue
with a screenshot and a trace, and feeds the [release watch window](../specs/release-watch-window-and-rollback.md).

Open: a browser runtime on both providers (Cloudflare Browser Rendering against a container on Zerops) and its cost; a
journey that writes data in production; and the repository rule that a flaky test is fixed or deleted, never retried,
which is harsh for a browser check against a live system. Decide the runtime before slicing.

Acceptance: a stage run whose journey fails is marked failed with the failing step; a production journey that fails three
times in a row raises one health alert and one issue.

## Touch points

- `packages/control/src/run-lifecycle.ts`, `packages/control/src/mcp/`
- `packages/operations/src/health*.ts`
- `packages/local-stack/src/browser-test.ts`

<!-- Origin: feature ideas review, 2026-11-02. -->
