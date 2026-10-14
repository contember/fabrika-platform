---
id: 165
title: fabrika app dev has no stand-in for an import
blocked-by: []
---

# 165 — `fabrika app dev` has no stand-in for an import

**Summary.** `app dev` stands in for a form's challenge and, through the dev outbox, for an outside HTTP provider, but
not for a `connect` import: an application that imports another application's export does not boot there. Effort: M.

## Problem

`devKit` passes no `connect` option, so `boot` refuses an import without its framework variables
(`FABRIKA_CONNECT_<IMPORT>_URL` and `_KEY`). The dev outbox cannot stand in for it: a connector's call is typed by the
owner's snapshot and must answer that output, which no capture can invent. The batch that added the dev outbox left it
out for that reason; the application that motivated it imports nothing.

## Approach / acceptance

- The simplest shape first: `app dev` wires each import to a stand-in owner that refuses every call with the
  connector's `unavailable` error, so the application boots and a screen shows its own handling of an unreachable
  owner. A seed-provided owner (`DevSeedResult.connect`, the owner kit's `fetch`) only if an application needs answers.
- Witness: `app-dev.test.ts` serves a fixture with one import; it boots, and a procedure that calls the import answers
  the connector's refusal.

## Touch points

`packages/cli/src/app-dev.ts`, `packages/app/src/testing/{dev.ts,kit.ts}`, `packages/app/skill/references/dev.md`.

<!-- Origin: the framework-gaps batch after the first React application (R-D2). -->
