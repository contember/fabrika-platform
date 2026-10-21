---
id: 199
title: Operations keeps every event forever
blocked-by: []
---

# 199 — Operations keeps every event forever

**Summary.** Operations deletes nothing: occurrences, dead events, health observations and raw event bodies grow without
bound, and so do its database disk, its bucket and every backup of them. A retention policy for the disposable data.

## Problem

The scheduled maintenance pass prunes only alert claims (`packages/operations/src/maintenance.ts`). ADR-0016 deferred
retention until its requirements were known. Raw bodies live in object storage, which Zerops does not back up; the SQL
index lives in `operationsdb`, whose dumps grow with it.

## Approach / acceptance

- A retention window per kind (occurrences, dead events, health and telemetry observations, raw bodies), with a default
  and an installation override.
- Configuration and triage state (`sources`, `ingest_credentials`, alert rules, channels, releases, source maps, issues and
  their activity) are never pruned by age.
- The pass deletes the SQL rows and the blobs they point at; the `BlobStore` port has no listing, so deletion goes by the
  keys the index holds.
- Tests on both runtimes' ports; an issue's counts stay correct after its old occurrences are pruned (or the counts are
  documented as the retained window).

## Touch points

`packages/operations/src/maintenance.ts`, the repositories, ADR-0016.
