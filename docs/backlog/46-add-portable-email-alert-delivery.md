---
id: 46
title: Add portable email alert delivery
blocked-by: []
---

# 46 — Add portable email alert delivery

**Summary.** Add email as a first-class Operations notification target over the shared `@fabrika/email` transport.

## Problem

Standalone Poplach can send alert email through a Cloudflare-specific binding. Operations currently supports webhook targets only, and its notification sender is shared by Cloudflare and Bun runtimes. `@fabrika/email` now supplies the portable sender and Resend adapter, but Operations still has no email target, durable payload, retry policy, or operator UI.

## Approach / acceptance

Extend the target DTO and durable outbox to use `@fabrika/email` without weakening webhook idempotency or logging secret payloads. Define Operations-owned templates, retry scheduling from `EmailDeliveryError.retryable`, target validation, and operator configuration. Prove equivalent delivery and retry behavior on Cloudflare and Bun compositions.

Acceptance requires typed configuration and operator UI, migration coverage for both SQL implementations, and one integration witness per composition using the shared adapter.

## Touch points

`packages/operations-contract`, `packages/operations`, `packages/operations-ui`, `packages/email`, Cloudflare and Bun composition configuration, Operations migrations.

<!-- Origin: ../archive/sprint-2026-07-31-operations-functional-parity.md -->
