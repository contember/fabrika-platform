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
12. **Access that 0.8.0 or 0.8.1 published into a namespace pinned to 0.4–0.6 is never judged again.** Those releases
    judged with the 0.7 parser too, so an approved entry with a 0.7-only form may sit in such a namespace.
    `assertNamespaceProxyReads` (`packages/provider-zerops/src/namespace/proxy-reads.ts`) judges only the entry being
    deployed or approved, so another member's republish fails at the pinned proxy's parser, and the error names neither
    that member's rows nor the re-pin. Fails closed; the old proxy keeps serving.
13. **An empty `Authorization` is treated differently by the three enforcement points.** Caddy's replace route
    (`packages/proxy/src/caddy.ts`) does not match an empty header, the Cloudflare proxy Worker and the test kit replace
    it with the minted token. No key leaks; no test pins either behaviour.
14. **`packages/auth/src/request.ts` still calls the `Authorization` fallback a machine `px_` key.** Behind a current
    proxy it carries the minted token; a `px_` key reaches it only on a request that bypasses the proxy.

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
12. Under the namespace lease, when the pin is not the current source, run `entriesNeedingCurrentProxy` over every member
    before `republishProxy` and refuse with the member ids, row ids and the re-pin. Witness: a test with an already
    published member that carries a 0.7 form.
13. Replace only when the value is non-empty after trimming, in all three; one test per enforcement point.
14. Reword the comment.

## Touch points

`packages/iam/src/{password-crypto,env}.ts`, `packages/iam/src/auth/{password,known-device}.ts`,
`packages/dashboard/src/routes/access/users/detail.tsx`, `packages/control/fabrika.service.ts`,
`packages/auth-core/src/token.ts`, `packages/proxy/src/__tests__/caddy.live.test.ts`, `packages/app/src/testing/proxy.ts`,
`packages/provider-contract`, `packages/control/src/platform-cf.ts`, `packages/provider-zerops`, `packages/proxy/src/caddy.ts`,
`packages/provider-cloudflare/src/proxy-worker.ts`, `packages/auth/src/request.ts`.

<!-- Origin: the independent reviews of the platform review's fix units, and a second review of PR #35's P1 and security fixes (items 12–14). -->
