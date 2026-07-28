---
id: 17
title: One gate matcher, not two — hoist it into auth-core
blocked-by: []
---

# 17 — One gate matcher, not two — hoist it into `auth-core`

The agent that built the proxy called this the highest-priority follow-up, and it is
right: **two implementations of an authorization check is exactly what
[ADR-0008](../decisions/0008-caddy-forward-auth-proxy.md) rejected a Go plugin to
avoid.** We avoided writing the second one in Go and then wrote it in TypeScript.

## Problem

`pathMatches`, `readBearer`, `readCookie` and `extractCredential` are private in
`packages/auth/src/session.ts` and now duplicated in `packages/proxy/src/gates.ts`.
They must agree exactly — [ADR-0010](../decisions/0010-gate-evaluation-stays-in-the-auth-service.md)
documents how subtly a path matcher can diverge (case sensitivity, whether `*`
crosses `/`, `//` normalisation) and that the divergence fails **permissively and
silently**.

Fold in the same class of problem: `PROXY_TOKEN_HEADER` is defined only by the
proxy, though the app-side SDK must use the identical name to read the injected
token. The example app's test asserts the two are equal, which proves the constant
is duplicated rather than shared. It belongs in `auth-core` too, along with the rule
that an empty value means absent.

## Acceptance

One exported matcher and one exported header constant in `@fabrika/auth-core`, used
by both the proxy and the SDK, with the divergence cases from ADR-0010 covered by
tests in the shared package. No copy left in either consumer.
