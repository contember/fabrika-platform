---
id: structured-logging
kind: pattern
title: Structured logging (handlers + child context + span/trace)
slot: null
provides: [structured-logging, log-correlation, leveled-logging]
requires: []
recommends: [observability]
conflicts: []
status: stable
sources:
  - where: "OpenTelemetry semantic conventions and W3C Trace Context"
    read: "Stable field names, trace propagation, span context, and structured errors."
  - where: "Sentry structured logs documentation"
    read: "Level filtering, contextual fields, and error forwarding."
---

# Structured logging

## What it is

A `Logger` built from **composable handlers** (`createLogger([handlers], baseAttrs)`),
with leveled, **structured** entries (`logger.info("event", { fields })`), `.child({
requestId, userId })` to attach correlation context at a boundary, and **span/trace
context** (AsyncLocalStorage + W3C `traceparent`) so logs correlate across RPC/DO
hops. Injected via the DI container — **never raw `console.log`** in app code.

## When & why to use

- Always, in a Worker/backend — searchable, correlatable logs (by requestId/traceId) instead of stringly console output that CF samples and drops.

## Anti-patterns (avoid these)

1. **`console.log` spam** — unstructured, no context, dropped under CF log sampling. → `logger.info("feature.event", { id })`.
2. **Logging secrets / PII / tokens** — leaks to Sentry, CF logs, DO logs (unredacted). → log ids + safe enums only; redact at the boundary.
3. **Logging in hot loops** — cardinality blowup + ring-buffer thrash. → log once with a `count`, not per item.
4. **Stringly-typed messages** (`"User " + id + " failed"`) — unsearchable, unaggregatable. → kebab event + structured attrs: `logger.warn("auth.login.failed", { userId })`.
5. **No requestId propagation** — logs fragment across services/DOs. → `.child({ requestId })` at the RPC boundary + propagate `traceparent`.
6. **Swallowing errors** (`catch { logger.warn("failed") }` without the error) — stack lost, Sentry blind. → `logger.error("op.failed", err, { ctx })`.

## Best practices

- One logger built in the DI container; `.child()` per request with `requestId`/`userId`.
- Kebab `feature.scope.event` message names + structured attrs; levels mean what they say.
- For complete (un-sampled) audit logs, add a durable handler (e.g. a DO ring-buffer), not just stdout.

## Relationships — why

- A pattern (no tech deps). **recommends `observability`** — structured logs are one of its three pillars; the Sentry handler ties into `sentry`.
