---
id: 46
title: Add portable email alert delivery
blocked-by: []
---

# 46 — Add portable email alert delivery

**Summary.** Add email as a first-class Operations notification target without coupling the portable alert outbox to Cloudflare Email Routing.

## Problem

Standalone Poplach can send alert email through a Cloudflare-specific binding. Operations currently supports webhook targets only, and its notification sender is shared by Cloudflare and Bun runtimes. Copying the old binding into the shared contract would break the multi-runtime boundary accepted by ADR-0016.

## Approach / acceptance

Choose and document a portable email transport contract, including credentials, sender identity, target validation, retry classification, and per-runtime adapters. Extend the target DTO and durable outbox without weakening webhook idempotency or logging secret payloads. Prove equivalent delivery and retry behavior on Cloudflare and Bun compositions.

Acceptance requires typed configuration and operator UI, migration coverage for both SQL implementations, sender conformance tests, and one integration witness per runtime adapter.

## Touch points

`packages/operations-contract`, `packages/operations`, `packages/operations-ui`, Cloudflare and Bun composition configuration, Operations migrations.

<!-- Origin: ../archive/sprint-2026-07-31-operations-functional-parity.md -->
