---
id: 18
title: Shrink @fabrika/auth now that the proxy enforces
blocked-by: [./17-one-gate-matcher-not-two.md]
---

# 18 — Shrink `@fabrika/auth` now that the proxy enforces

[ADR-0007](../decisions/0007-proxy-based-auth-enforcement.md) predicts the app-side
SDK shrinks a lot once enforcement moves into the proxy. The proxy is built; the
shrink has not happened, so both paths currently exist and an app could still wire
the old in-process enforcement and believe it is protected.

## What goes

- **`session.ts` (≈353 lines) deletes entirely** — gate evaluation, session→token
  exchange, `mintFromKey`, the key and JWKS caches, the login-URL builder, the
  `px_token` cookie writer. `PropustkaAuth` stops being a public export.
- **`iam.ts` loses most of its middleware factories** (`AuthMiddlewareConfig`,
  `ApiKeyMiddlewareConfig`, `CapabilityMiddlewareConfig`) — they exist to wire
  enforcement into the app pipeline, which is precisely what stops being the app's
  job.
- `LoginRequiredError` / `loginUrl` become dead weight: the proxy issues the bounce,
  so the app never sees an unauthenticated human on a gated path.

## What stays

Read `X-Fabrika-Token`, verify signature/`iss`/`aud`/`exp` against the JWKS
(**defence in depth — the app must not trust the header blindly**), build an
`AuthContext`, and expose `can()` / `scopedTo()` / `applyScope()` /
`requirePermission()` / `audit()` for the per-resource checks a per-path gate cannot
make. Plus `IamClient` / `FakeIamClient`, which are unrelated to enforcement.

**One thing must NOT be deleted:** `redeemKey`. Share-link capabilities are redeemed
_off_ the gate path — those requests hit a `public` or `service` gate and the app
redeems the capability itself. There is no proxy equivalent by design.

## Acceptance

The published SDK no longer offers a way to enforce gates in-process; every
downstream app (poplach, revizor, opice) has a documented migration; and the
share-link path still works.
