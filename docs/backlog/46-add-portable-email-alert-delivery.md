---
id: 46
title: Add portable email alert delivery
blocked-by: []
---

# 46 — Add portable email alert delivery

**Summary.** Add email as a first-class Operations notification target over the shared `@fabrika/email` transport.

## Problem

The standalone predecessor error tracker could send alert email through a Cloudflare-specific binding. Operations currently supports webhook targets only, and its notification sender is shared by Cloudflare and Bun runtimes. `@fabrika/email` now supplies the portable sender and Resend adapter, but Operations still has no email target, durable payload, retry policy, or operator UI.

## Approach / acceptance

Extend the target DTO and durable outbox to use `@fabrika/email` without weakening webhook idempotency or logging secret payloads. Define Operations-owned templates, retry scheduling from `EmailDeliveryError.retryable`, target validation, and operator configuration. Prove equivalent delivery and retry behavior on Cloudflare and Bun compositions.

On Zerops, Operations sends through Control's mail relay as an installation sender, as IAM does
([ADR-0019](../decisions/0019-portable-outbound-email.md) §8): the relay records it, always passes it and dispatches
it, so Operations needs no dispatcher of its own there. It needs an installation key of its own, derived from a secret
it shares with Control, and the relay must accept that sender.

Acceptance requires typed configuration and operator UI, migration coverage for both SQL implementations, and one integration witness per composition using the shared adapter.

## Touch points

`packages/operations-contract`, `packages/operations`, `packages/dashboard` (Operations views), `packages/email`, Cloudflare and Bun composition configuration, Operations migrations.

<!-- Origin: ../archive/sprint-2026-07-31-operations-functional-parity.md -->
