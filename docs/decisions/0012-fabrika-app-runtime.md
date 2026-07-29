---
id: 0012
title: Absorb the Trasa server framework as @fabrika/app
status: accepted
date: 2026-07-29
---

# 0012 — Absorb the Trasa server framework as `@fabrika/app`

## Context

fabrika owns an application's deployment declaration, identity model, authorization
policy, proxy enforcement, and audit path, but it has no server-side application
framework. Applications still assemble their own HTTP routing and request pipeline.

Trasa was created separately as a Fetch-based HTTP and typed-RPC framework. Its
middleware and authorization contracts were deliberately frozen to mirror
`@fabrika/auth`, and its `.require()` procedure guard implements the object-level
authorization that remains the application's responsibility after the proxy admits
a request. The repositories therefore have a real product and contract dependency
despite separate names and release cycles.

Keeping the generic framework separate would require a permanent compatibility
contract, coordinated releases, and separate documentation for one application
programming model.

## Decision

We will retire the standalone Trasa project and move its implementation into
fabrika-platform as the published `@fabrika/app` package.

`@fabrika/app` owns:

- Fetch-based HTTP routing and middleware;
- the typed RPC server, wire protocol, and browser client;
- structural HTTP error mapping;
- procedure-level action and scope checks through `.require()`.

It imports the canonical `AuthContext`, `Scope`, and `Middleware` contracts from
`@fabrika/auth`; it does not keep structurally duplicated Trasa contracts.

The runtime package stays separate from provider authoring packages. A
`fabrika.config.ts` describes deployment, gates, and resources. `@fabrika/app`
handles requests after deployment. Proxy gates remain the structural front door;
`.require()` performs object-level authorization that only application code can
resolve.

The first migration preserves the existing Worker-shaped `defineServer()` API.
The routing, middleware, RPC, and client layers remain Fetch-based. Other hosting
adapters may be added without changing those core contracts.

## Consequences

- Fabrika gains one first-party application model from proxy admission through
  object authorization and typed RPC.
- Auth and server-framework changes can land and be tested atomically.
- Applications install `@fabrika/app`, not `@trasa/core`.
- The independent Trasa name, package, repository, and release stream are retired.
- `@fabrika/app` is coupled intentionally to `@fabrika/auth` and no longer claims
  zero dependencies.
- Provider-specific process lifecycle remains outside the core request framework.

## Alternatives considered

- **Keep `@trasa/core` independent and add a Fabrika integration package.**
  Rejected: the frozen shared contracts and coordinated documentation would
  preserve a repository boundary across one product surface.
- **Re-export Trasa from a provider authoring package.** Rejected: deploy-time
  configuration and request-time execution have different consumers and
  lifecycles.
- **Move proxy gates into route or RPC definitions.** Rejected: the proxy needs
  static gate data before a request reaches application code, while `.require()`
  depends on application-owned object context.
