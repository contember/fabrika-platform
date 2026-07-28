---
id: 03
title: Phase 3 — introduce DeployDriver, move plan derivation into the CF driver
blocked-by: [./02-phase-2-node-bun-and-postgres.md]
---

# 03 — Phase 3 — introduce `DeployDriver`, move plan derivation into the CF driver

**Summary.** Add the `DeployDriver` seam and relocate Cloudflare's plan derivation
into the Cloudflare driver — **with behaviour unchanged**.

## Problem

`buildPlan` in `@fabrika/engine` hard-codes a Cloudflare-shaped step order
(build → provision → migrate → deploy-worker → reconcile-schema → sync-secrets).
Per [ADR-0002](../decisions/0002-deploy-driver-owns-the-plan.md), the plan belongs
to the driver.

## Approach / acceptance

Define `DeployDriver`; implement `CloudflareDeployDriver` by moving `buildPlan`
into it verbatim. The engine keeps only plan **execution** — progress, logs,
failure handling, cancellation.

This rung must be **behaviour-neutral**: it is the refactor that has to be
verifiable against existing tests _before_ Zerops introduces genuinely new
behaviour in phase 4. Do not sneak Zerops accommodations in here.

Acceptance: existing deploy tests pass with no changes to their expectations; the
produced plan for any given app is byte-identical to phase 2's.

Watch the seam confusion: _what happens and in what order_ → driver; _what touches
the network/filesystem_ → the existing `DeployRuntime` (which stays, for testing).

## Touch points

`@fabrika/engine` (`buildPlan`, `DeployRuntime`), `@fabrika/control`.
