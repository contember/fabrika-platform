---
id: 243
title: The reader and classifier fixes of #73 have no regression tests
blocked-by: []
---

# 243 — The reader and classifier fixes of #73 have no regression tests

**Summary.** #73 restored two behaviours without a test that fails when they regress. P2; size S.

## Problem

1. `packages/check/src/reader/value.ts` reads a vocabulary's `members`, `directory` and `terminal` again. No reader
   fixture carries them, so dropping them once more makes the approved digest differ from the application's runtime
   digest while the differential tests stay green.
2. `packages/platform-node/src/sql-names.ts` allows `strftime`, the function of the prescribed SQLite timestamp
   default. No classifier test covers it, so removing it refuses that default again without a red test.

## Approach / acceptance

- A `defineVocabulary` fixture with all three fields, comparing the reader's canonical artifact with the runtime's.
- A classifier test that accepts the prescribed default without deviations and still refuses an unknown function.

<!-- Origin: post-merge review of #73. -->
