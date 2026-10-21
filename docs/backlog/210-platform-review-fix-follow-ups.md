---
id: 210
title: Follow-ups of the platform review fixes
blocked-by: []
---

# 210 — Follow-ups of the platform review fixes

**Summary.** Small findings that the independent reviews of the platform review's fixes left open. None reopens a
fixed hole. P3, size S each.

## Problem

1. **A Worker composition that omits `PASSWORD_COST` hashes at the Bun cost.** `WebCryptoPasswordHasher` defaults to
   `BUN_PBKDF2_COST` (`packages/iam/src/password-crypto.ts:110`) and `PASSWORD_COST` is optional
   (`packages/iam/src/env.ts:80`). A new Cloudflare composition that forgets it writes hashes that Cloudflare cannot
   derive.
2. **The console still offers password enrollment and reset to a scoped user administrator.** IAM now answers 403
   for kind `users` without a mail sender (ADR-0058 §5), but `packages/dashboard/src/routes/access/users/detail.tsx`
   shows both buttons and shows the 403 as an error.
3. **Control's IAM admin rows still admit `machine`.** `packages/control/fabrika.service.ts:53-54` lists
   `callers: ['human', 'machine']` for `iam-admin-rpc` and `iam-admin-root`. IAM's JWT branch now requires a session
   token, so a machine caller always reaches a 403 after the proxy admits it.
4. **The known-device bucket is check-then-act.** `packages/iam/src/auth/password.ts:143-147` reads the device bucket
   and records the failure later, as the account bucket does. A parallel burst with one stolen cookie can exceed ten
   attempts; on Zerops no per-client bucket bounds the burst.
5. **A password reset does not invalidate known-device cookies.** A stolen cookie keeps its own bucket (ten guesses
   per fifteen minutes) on the victim's account for up to ninety days after a reset or logout.
6. **Missing known-device tests.** No test pins that a valid device cookie still meets a blocked per-client bucket, or
   that failures from a known device do not fill the global bucket.
7. **`FABRIKA_COOKIE_PREFIX` says the prefix holds every IAM browser credential.** `packages/auth-core/src/token.ts:34`.
   `__Host-fabrika_oidc` and `__Host-fabrika_device` are IAM cookies outside it, because the proxy strips the prefix.
8. **The live Caddy suite cannot see a duplicated `Authorization` line.** `packages/proxy/src/__tests__/caddy.live.test.ts`
   uses `Bun.serve` upstream, which merges repeated headers. The review's raw-socket probe covered repeated and
   differently cased `Authorization` and an installation row whose auth response carries a token.
9. **`ProxyOutcome.keepsAuthorization` changed meaning.** `packages/app/src/testing/proxy.ts:34` is false on a
   credentialed row, and `asserted` may now hold `Authorization`. External users of `endpointProxy` need a migration
   note.
10. **The Cloudflare provider reads Control's run row to learn a run's trigger.** `ProviderSourceResolutionInput` has no
    trigger, so `packages/control/src/platform-cf.ts` reads `runs` by id for the branch check of ADR-0048. A `trigger`
    field on the provider contract removes that read.
11. **Zerops checks the branch for a manual pinned run; Cloudflare does not.** Zerops fetches the branch tarball and
    compares the commit for every run with an expected commit, so an approved manual run fails on Zerops after the
    branch moved and deploys on Cloudflare.

## Approach / acceptance

1. Make the cost a required constructor argument, or required in the Worker `iamEnv` type. Witness: typecheck.
2. Hide or disable both buttons when the actor is not `iam.admin` and no sender is configured. Witness: a dashboard
   test.
3. Drop `machine` from both rows, after checking that no machine caller of `/iam/admin` exists.
4. Record the device attempt first and decide from the returned row, as `clientBlocked` does; fix the account bucket
   the same way. Witness: a parallel-burst test.
5. Sign the credential's `updated_at` into the cookie and compare it at read.
6. Add both tests to `known-device.test.ts`.
7. Reword the comment to name the two exceptions.
8. Port the probe's raw-socket upstream cases into the live suite.
9. Add the note to the framework migration guide of the next minor.
10. Add `trigger` to `ProviderSourceResolutionInput` and pass it from Control (additive contract change).
11. Decide one rule for manual pinned runs and apply it on both providers; state it in ADR-0048.

## Touch points

`packages/iam/src/{password-crypto,env}.ts`, `packages/iam/src/auth/{password,known-device}.ts`,
`packages/dashboard/src/routes/access/users/detail.tsx`, `packages/control/fabrika.service.ts`,
`packages/auth-core/src/token.ts`, `packages/proxy/src/__tests__/caddy.live.test.ts`, `packages/app/src/testing/proxy.ts`,
`packages/provider-contract`, `packages/control/src/platform-cf.ts`, `packages/provider-zerops`.

<!-- Origin: the independent reviews of the platform review's fix units. -->
