---
id: 294
title: Control cannot export a restored original
blocked-by: []
---

# 294 — Control cannot export a restored original

**Summary.** A side restore rewinds the original object to the target time, but no Control verb exports or reads it,
so the rows at that time cannot be recovered or checked. P2, size M.

## Problem

ADR-0070 §9 step 7 recovers the rows from "a consistent export of the original, which is `inspect`". The object
serves that export (§11, `export` without a generation), but Control starts exports only inside a backup of the
serving object (`src/backups.ts`, `src/data-operations.ts`), and `data.view` and `data.content` read the serving object
only. After a live side restore the clone served the current data and Control's `check` confirmed the original's mode
and ledger, but nothing showed the original's rows at the target time.

## Approach / acceptance

A `data.start` kind (or a step of the restore) that exports a listed, non-serving object in `inspect` into
`__fabrika/exports/<object>/<dump>/`, under `data.manage`, and a read of its manifest's per-table counts under
`data.read`. Acceptance: after a side restore, the export of the original shows the row counts of the target time, in
a test of `data-operations.ts` and once on a live installation.

## Touch points

`packages/control/src/data-operations.ts`, `packages/control-contract/src/rpc.ts`, `packages/dashboard/`.
