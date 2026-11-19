---
id: 288
title: Reader input discovery parses every held module again in each round
blocked-by: []
---

# 288 — Reader input discovery parses every held module again in each round

**Summary.** Control's import discovery costs rounds × held bytes of parsing, so a deep import chain can exceed a
Worker's CPU limit before the contract is read. Effort: S to M.

## Problem

- `readAccessSnapshot` (`packages/control/src/approval/read.ts`) calls the selected reader's `inputs` once per round,
  up to `SNAPSHOT_LIMITS.readerRounds` (32). Each call is `contractReaderInputs` (`packages/check/src/inputs.ts`), or an
  older reader's own, and it parses every module fetched so far.
- A chain of imports needs one round per link, so the parse work grows with the square of the chain depth.
- Measured in Bun, discovery only, on 30 modules of 2.37 MB in all:
  - imported directly from the contract: 2 rounds, 1.6 s;
  - each module importing the next: 31 rounds, 19.8 s.
- `readerTotalChars` (twice `sourceBytes`, 8 Mi characters) bounds what is held, not how often it is parsed. Not
  measured, extrapolated: a 32-link chain at that size takes about 70 s, and about 35 s at the earlier 4 Mi. Control's
  Worker sets no `cpu_ms`, so the default 30 s applies. The run then fails on the CPU limit, with no refusal code in
  its log.
- Only a developer of the installation's applications can write such a commit, and it costs CPU, not data.

## Approach / acceptance

- Parse each fetched module once across rounds. For example, Control keeps each module's imports between rounds, or
  this release's reader takes the previous round's result. Older readers stay as they are, or they get the same
  wrapper if their `inputs` allows it.
- Alternatively, bound the parse work directly (rounds × held characters) and refuse with `contract-too-large`.
- Acceptance: a test with a 32-link chain at `readerTotalChars` parses each module once, or is refused before
  discovery passes its bound. Record a workerd CPU measurement of the worst case in `packages/check/CLAUDE.md`
  beside the heap figures.

## Touch points

`packages/control/src/approval/read.ts`, `packages/control/src/approval/readers.ts`, `packages/check/src/inputs.ts`.

<!-- Origin: review round 1 of the PR that raised CONTRACT_LIMITS to 4 MiB / 400 000 / 60 000. -->
