---
id: 269
title: Masked production data for dev and stage
blocked-by: []
---

# 269 — Masked production data for dev and stage

**Summary.** Tables mark their personal columns, the marking goes through the access approval, and Control seeds a dev
sandbox or stage from a masked copy of the latest production backup. Large.

## Problem

An agent reproduces a bug on an empty or hand-seeded dev database. Copying production data into a dev sandbox would hand
personal data to whatever model the person's client uses. Nothing in an application's tables says which columns hold
personal data.

## Approach / acceptance

Each column of `src/db/tables.ts` declares a class (`personal`, `secret`, `free`). The class is part of the approved
access ([ADR-0050](../decisions/0050-approved-access.md)): a new unmasked personal column is a widening the approval
shows. Control produces a masked snapshot from the latest backup (deterministic fakes that keep references and
uniqueness) and seeds a dev sandbox or stage with it (`reset_dev` with a source). The platform already reads
`tables.ts` at the pinned commit and has backups and an importer
([ADR-0070](../decisions/0070-data-protection-of-an-application-environment-on-cloudflare.md),
`packages/control/src/{backups,data-operations}.ts`).

What exists does not yet form that path. The backup scheduler does nothing without the
provider's data operations (`packages/control/src/backups.ts:63`), dev sandboxes are Zerops only
(`packages/control/src/api/registry/environments.ts:210`), and `reset_dev` resets the schema and imports nothing
(`packages/control/src/api/dev-environments.ts:308`). The first version names one provider pair (Zerops production into a
Zerops dev sandbox needs a Zerops backup first; Cloudflare needs Cloudflare dev sandboxes,
[271](271-fast-dev-sandboxes-on-cloudflare.md)) and refuses every other combination.

Open: free-text columns hold personal data that no class catches (default: a `free` text column is masked unless
declared otherwise); who may request a masked seed; the same classification could later drive per-person export and
erasure, which is a separate item. Needs an ADR on the classification before code.

Acceptance: a seeded dev sandbox holds no value of a `personal` column from production, keeps every foreign key valid,
and the approval of a commit that adds an unclassified text column shows it.

## Touch points

- `packages/db/` (column class in table declarations), `packages/check/` (a rule for unclassified columns)
- `packages/control/src/approval/`, `packages/control/src/backups.ts`, `packages/control/src/data-operations.ts`
- `packages/control/src/dev/`

<!-- Origin: feature ideas review, 2026-11-02. -->
