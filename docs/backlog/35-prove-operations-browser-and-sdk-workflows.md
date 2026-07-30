---
id: 35
title: Prove Operations browser and SDK workflows
blocked-by: []
---

# 35 — Prove Operations browser and SDK workflows

**Summary.** Add the missing browser-level evidence for the Operations console
and prove managed ingest with an official Sentry browser SDK.

## Problem

The Operations service, same-origin gateway, feature UI, managed DSN, and
asynchronous ingest path are implemented and covered by unit, contract, and
HTTP tests. The imported Poplach browser scenarios were intentionally not
copied into a working browser harness. Neither example application currently
sends an exception through an official Sentry SDK using
`FABRIKA_OPERATIONS_DSN`.

The foundation therefore proves the component contracts but not the complete
browser adoption workflow.

## Approach / acceptance

- Add a maintained browser harness for the unified console.
- Prove unauthenticated login bounce, same-origin mutation enforcement, and
  navigation among Delivery, Access, and Operations.
- Exercise issue list and detail, filtering, bulk status, comments, assignment,
  snooze, merge, alert settings, release links, source context, and health.
- Prove that a scoped principal cannot infer counts, DSNs, alert targets, or
  release details for an unauthorized application environment.
- Stop Operations and verify a bounded unavailable state while Delivery and
  Access remain usable.
- Configure an example browser app from `FABRIKA_OPERATIONS_DSN` and
  `FABRIKA_RELEASE`, send an exception through a supported official Sentry SDK,
  observe `202`, and query exactly one grouped issue after asynchronous
  consumption.
- Record the supported SDK and envelope-item compatibility in application-facing
  documentation.

## Touch points

- `packages/dashboard/`
- `packages/operations-ui/`
- browser scenarios and local-stack fixtures
- `examples/app/` and application-facing documentation

<!-- Origin: Operations plane foundation WU1, WU4, WU7, and WU9. -->
