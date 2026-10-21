---
id: 206
title: IAM token and OIDC hardening
blocked-by: []
---

# 206 — IAM token and OIDC hardening

**Summary.** Two small IAM gaps: the shared token verifier accepts any algorithm its key set allows, and a thrown
OIDC discovery or token fetch skips the refusal path. Neither is exploitable today. P3, size S each.

## Problem

1. **The verifier pins no algorithm.** `verifyWith` (`packages/jwks/src/verifier.ts:135-145`) calls
   `jwtVerify(token, keys, { issuer, audience })` without `algorithms`. jose then takes the algorithm from the token
   header, limited only by the JWKS key's type. IAM's keys are EC P-256 and IAM signs ES256 (`TOKEN_ALG`,
   `packages/auth-core/src/token.ts:60`), so no other algorithm verifies today; a key of another type in the set
   would widen it. IAM's own verifier already pins `[TOKEN_ALG]` (`packages/iam/src/signing.ts:158`).
2. **A thrown OIDC fetch skips `refuse()`.** `exchangeCode` (`packages/iam/src/oidc.ts:128-141`) awaits
   `metadata()`, which throws on a failed discovery (`oidc.ts:202-206`), and `fetch`, which throws on a network
   error. The callback (`packages/iam/src/auth/oidc.ts:91`) does not catch it, so the request answers 500: no
   `auth_log` row, and the flight cookie is not cleared. That breaks the callback's own rule that every
   terminal outcome consumes the flight (`auth/oidc.ts:80-82`). `verifyIdToken` already catches both.

## Approach / acceptance

1. Pass `algorithms: ['ES256', 'ES384', 'ES512']` in `verifyWith`. Not ES256 alone: `@fabrika/jwks` ships inside
   each application's framework release, and a platform that later signs with another EC curve must still be read
   by the older releases of the support window (ADR-0062). Witness: a `packages/jwks` test that an HS256 token and an
   `alg: none` token are refused and an ES384 token over a P-384 key verifies.
2. Catch inside `exchangeCode` and return `null`, as its doc comment already promises ("null on any failure"). The
   callback then refuses with `oidc_code_exchange_failed`, 502. Witness: an `auth-routes` test whose token endpoint
   throws, asserting a 502, an `auth_log` row and a cleared flight cookie. Log a short message, never the error
   object.

No migration, no protocol change.

## Touch points

`packages/jwks/src/verifier.ts`, `packages/iam/src/oidc.ts`, `packages/iam/src/__tests__/`, `packages/jwks/src/__tests__/`.

<!-- Origin: a platform review. -->
