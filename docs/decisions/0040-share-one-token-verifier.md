---
id: 0040
title: Share one token verifier between the SDK and the proxy
status: accepted
date: 2026-09-03
---

# 0040 — Share one token verifier between the SDK and the proxy

## Context

`@fabrika/auth` and `@fabrika/proxy-core` each carried their own JWKS-backed
access-token verifier — about 105 lines apiece, with the same three-state result,
the same unknown-`kid` sentinel and the same `jose` calls. The comment in the
first one said it was "exactly like `@fabrika/proxy`'s verifier".

That duplication was **deliberate**. The
[auth-hardening sprint](../archive/sprint-2026-08-04-auth-hardening.md) considered
one shared `TokenVerifier` and rejected it by name: `@fabrika/auth-core` is
dependency-free and jose-free on purpose, the proxy must not depend on the app
SDK, and a package existing to share ~90 lines "would be the over-engineering
this sprint is removing". What it judged worth protecting was the **three-state
semantics** — `valid` / `invalid` / `unavailable`, where collapsing the last two
would let a JWKS outage read as a forged token — and it pinned that with
`token-verifier-conformance.test.ts` instead of sharing code.

The reasoning held everywhere except one place, and that place is why this ADR
exists. The proxy bounds unknown-`kid` refetches with a cooldown; the SDK did
not, and the conformance test **asserted that asymmetry as correct**:

> the proxy rate-limits unknown-kid refetches; the SDK does not, because it
> cannot be driven

The justification is that the SDK only ever sees a token the proxy injected,
because the generated Caddy config strips the inbound header. That is true of a
correct fabrika deployment. But `@fabrika/auth` is **published to npm**, and a
library cannot enforce the topology it is deployed into. The one behavioural
difference between the two copies was therefore protected by an invariant that
lives outside the package holding it — and a conformance test that pins semantics
is, by construction, the wrong instrument to catch that: it compared verdicts,
and the verdicts already agreed.

## Decision

We will keep **one** verifier, in a new package `@fabrika/jwks`, and reduce both
`@fabrika/auth` and `@fabrika/proxy-core` to thin wrappers over it.

`@fabrika/auth-core` stays dependency-free — the new package depends on `jose`,
`auth-core` does not depend on the new package, and neither consumer depends on
the other. The cooldown now applies on both sides.

The cache and the cooldown travel together in one injectable slot, because the
SDK caches per `IamRpc` binding — `@fabrika/app` builds a verifier per request,
so cooldown state held per instance would reset every request and bound nothing.

`token-verifier-conformance.test.ts` **stays**. Two wrappers over one core can
still disagree, and the table is what proves they do not.

## Consequences

- The security-critical path exists once. A hardening change lands in one place.
- `@fabrika/auth` gains a bound it was missing. This is defense in depth, not a
  fix for a reachable vulnerability: in a correct deployment the proxy strips the
  inbound token header, so the input this bounds does not arrive.
- One more package — 35 now. This repository already carries seven contract
  packages, and package count is a real cost noted against it. The distinction
  claimed here is that `@fabrika/jwks` carries runtime code two packages that must
  not import each other both execute, rather than types.
- The earlier judgement is reversed, not overlooked. Anyone who finds the archived
  "considered and rejected" note should find this ADR from it.
- Not addressed: `jose` stays in both consumers' dependencies, because
  `proxy-core`'s test helpers are imported cross-package and resolve it from there.

## Alternatives considered

**Move the verifier into `@fabrika/auth-core`.** Fewest packages, and the kernel is
already the shared home for the token model. Rejected: `auth-core` has zero
dependencies by design, is imported by 16 packages, and reaches the browser bundle
transitively through `iam-contract` → `dashboard`. That import is type-only today,
so nothing breaks immediately — which is exactly what makes it a bad place to put
`jose`.

**Keep both copies and only add the cooldown to the SDK.** Smallest change, honours
the earlier decision, and closes the actual weak point. Rejected because it leaves
the next divergence to be caught by a test that already demonstrated it does not
catch this class: the conformance table compares verdicts, and a resource bound is
not a verdict.

**Have one consumer import the other.** Rejected in the original sprint and still
right: the app SDK must not pull in enforcement code, and the proxy must not pull
in the app SDK.
