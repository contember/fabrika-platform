---
id: 200
title: Recovering a lost Operations database
blocked-by: []
---

# 200 — Recovering a lost Operations database

**Summary.** The light tier's `operationsdb` is single-node with a daily dump. State what an installation must redo when it
is lost or restored from an older dump, and make Control re-sync what it can.

## Problem

`operationsdb` holds disposable events, but also configuration: `sources` and `ingest_credentials` (the DSNs applications
report with), alert rules, notification channels, releases and source maps. Control projects its catalog into Operations
(`packages/operations/src/catalog.ts`, the sync key), but it is not verified that a reconcile recreates sources and
ingest credentials that the applications' deployed DSNs still name, or what a restore to an older dump does to them.

## Approach / acceptance

- A test that empties (or rewinds) Operations' tables and shows what Control's next reconcile restores and what an
  application keeps reporting with.
- An operator runbook section in `docs/reference/` for a lost or restored `operationsdb`.

## Touch points

`packages/operations/src/catalog.ts`, Control's catalog projection, `docs/reference/`.
