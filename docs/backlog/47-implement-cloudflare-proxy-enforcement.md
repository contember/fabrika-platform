---
id: 47
title: Implement the Cloudflare proxy enforcement path
blocked-by: []
---

# 47 — Implement the Cloudflare proxy enforcement path

**Summary.** Implement ADR-0007 and ADR-0008's thin Cloudflare Worker so app Workers are private, the proxy is the only public route, and the shared TypeScript authorizer supplies the verified upstream token.

## Problem

The Zerops composition deploys Caddy plus the shared TypeScript auth service, but the Cloudflare composition does not deploy its accepted equivalent. `@fabrika/provider-cloudflare` has no proxy authoring or deploy path. The worked Cloudflare app, Control, and Operations attach public routes directly and still depend on `PropustkaAuth` for path-gate enforcement.

This blocks [item 18](./18-shrink-the-app-sdk.md). Removing in-process enforcement first would either reject every protected Cloudflare request because no proxy injects `X-Fabrika-Token`, or leave a directly routed application without the structural boundary ADR-0007 requires.

## Approach / acceptance

- Define the thin Worker composition that reuses the existing TypeScript authorizer; do not implement a second gate evaluator.
- Distribute each app's ordered gate manifest to the Cloudflare proxy without adding a provider-neutral closed union.
- Move public routes and custom domains from app Workers to the proxy. App Workers must be reachable only through service bindings.
- Preserve streaming, WebSocket, body, redirect, cookie, and request-correlation semantics appropriate to Cloudflare's native proxying.
- Make the proxy delete any client-supplied injected-token header before authorization and set only a verified token on the upstream request.
- Migrate the worked Cloudflare app, Control, and Operations. Prove direct app access is unavailable and proxy-routed public, service, and human gates match the shared ADR-0010 matrix.
- Keep IAM global and the proxy stateless. Never give the proxy audit-write authority or log credentials.

Acceptance: both provider compositions structurally enforce gates before application code, use the same TypeScript matcher/authorizer, and deliver a verified `X-Fabrika-Token` to protected app routes. Cloudflare conformance covers login bounce, service credentials, public paths, invalid-token denial, gate ordering, streaming, and bypass resistance. Item 18 can then remove `PropustkaAuth` without breaking a provider.

## Touch points

- `packages/proxy/`
- `packages/provider-cloudflare/`
- `packages/installation-cloudflare/`
- Cloudflare app authoring and generated Worker configuration
- `packages/control/`, `packages/operations/`, and `examples/app/`

<!-- Origin: auth-boundary cleanup sprint WU2 verify-first. -->
