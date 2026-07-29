---
id: 0013
title: Expose runtime adapters through explicit package entrypoints
status: accepted
date: 2026-07-29
---

# 0013 — Expose runtime adapters through explicit package entrypoints

## Context

ADR-0012 moved the Trasa framework into `@fabrika/app`. The first migration kept
the Worker-shaped `defineServer()` API and later added a Bun handler. Both
adapters were exported from the package root, while the same `server.ts` module
owned the runtime-neutral request pipeline and Cloudflare cron and queue types.

This made the application definition appear provider-specific and exposed Bun
and Cloudflare lifecycle APIs to every consumer. It also let Cloudflare lifecycle
configuration become part of request application construction even though cron
and queue handlers do not participate in request routing.

## Decision

The `@fabrika/app` package root will expose only the runtime-neutral application
API. `defineApp()` produces one `FabrikaApp` that owns routing, middleware, RPC,
error mapping, and request context creation.

Runtime adapters will use explicit subpath exports:

- `@fabrika/app/cloudflare` exposes `createCloudflareWorker()` and Cloudflare
  lifecycle types;
- `@fabrika/app/bun` exposes `createBunHandler()` and Bun process lifecycle
  types.

Adapters consume a `FabrikaApp`; they do not accept or duplicate its request
configuration. Cloudflare cron and queue handlers belong to the Cloudflare
adapter options. Bun background-task tracking and draining belong to the Bun
adapter.

Both adapters remain in the `@fabrika/app` npm package. A separate package is not
required while the adapters have no independent dependency or release boundary.

## Consequences

- Application modules can be imported and tested without importing a provider
  lifecycle surface.
- Runtime entrypoints state their target explicitly in source imports.
- Worker and Bun deployments exercise the same request application.
- Adding a runtime no longer expands the package root API.
- The pre-release `defineServer()` API is removed in favor of composing
  `defineApp()` with `createCloudflareWorker()`.
- A future adapter may become a separate package if it gains substantial
  provider dependencies or needs an independent release cycle.

## Alternatives considered

- **Keep every adapter in the package root.** Rejected: autocomplete and module
  boundaries would continue to mix portable application code with provider
  lifecycle code.
- **Select an adapter through conditional exports.** Rejected: runtime selection
  would become implicit and bundler-dependent, while application entrypoints
  should state which lifecycle they implement.
- **Publish one npm package per adapter now.** Rejected: it adds versioning and
  release overhead without isolating any current dependency.
