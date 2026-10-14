---
id: 163
title: The installation hosts send no HSTS
blocked-by: []
---

# 163 — The installation hosts send no HSTS

**Summary.** The proxy adds `Strict-Transport-Security` only to an `https` application host; IAM's and Control's
hosts, which take passwords and admin sessions, get none. Effort: S.

## Problem

`transportPolicy` (`packages/proxy-core/src/headers.ts:140`) is joined only to a contract application's policy
(`appHeaderPolicy`). An installation service's entry gets `BASE_HEADER_POLICY`
(`packages/proxy-core/src/service.ts:99`), with no transport header, and ADR-0022's HSTS paragraph says an answer that
belongs to no application host carries none. So the sign-in page, the set-password page and the console are reachable
over a downgraded first request, while the applications they serve are pinned to `https`.

## Approach / acceptance

- Decide where the scheme of an installation host comes from (the manifest entry, as for an application) and give
  every `https` installation entry the transport policy; an `http` host (the local stack) still gets none.
- Same rules as for applications: `max-age=31536000`, no `includeSubDomains`, no `preload`.
- Rewrite ADR-0022's HSTS paragraph in place.
- Witness: a proxy-core header test for an `https` and an `http` installation entry, on both providers.

## Touch points

`packages/proxy-core/src/{headers.ts,service.ts}`, `packages/provider-cloudflare/src/proxy-worker.ts`,
`docs/decisions/0022-the-proxy-is-the-only-enforcement-point.md`.

<!-- Origin: the paved-road sprint, WU20 (deferred in its OUTCOME). -->
