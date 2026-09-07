---
id: observability
kind: pattern
title: Observability on Workers (logs + metrics via Analytics Engine + traces)
slot: null
provides: [observability, tracing, metrics]
requires: []
recommends: [analytics-engine, structured-logging, sentry]
conflicts: []
status: stable
sources:
  - where: "Cloudflare Analytics Engine docs"
    read: "writeDataPoint, SQL queries, sampling behavior, and binding limits."
  - where: "Cloudflare docs (Workers observability logs/traces, Analytics Engine) + oblaka's AE resource and `observability: { enabled: true }`"
    read: "How logs/traces are enabled in wrangler/oblaka, the AE writeDataPoint limits, and tail workers."
---

# Observability on Workers

## What it is

The three pillars, the way they fit Cloudflare Workers:

- **Logs** — `structured-logging` to stdout, with `observability: { logs: { enabled: true } }` in wrangler/oblaka so CF ingests them (CF **samples** under load → keep a durable handler for complete audit).
- **Metrics** — **Analytics Engine** via `writeDataPoint`, hidden behind an **`AnalyticsSink` port** with a **typed event union**; the AE adapter in prod, a capturing sink in tests (see `count-store` for the same local/AE split).
- **Traces** — W3C `traceparent` + AsyncLocalStorage span context; `observability: { traces }` + Workers tail workers. **No heavy OpenTelemetry SDK** — ports/adapters + structured spans cover it.

## When & why to use

- Any production Worker — you want correlation (requestId/traceId across hops), metrics that survive bursts (AE append, not D1 UPDATE), and a path to debug incidents.

## When NOT to use

- A throwaway/local-only app — structured logs alone suffice; skip AE wiring.

## Gotchas

- **AE cardinality limits**: ≤1 index (≤96 B), ≤20 doubles, ≤20 blobs (~16 KB/row) — **no free-form strings as blobs**; use stable enums + ids.
- **CF samples logs** under load — don't rely on stdout logs for a complete audit trail; add a durable (DO) handler if you need every line.
- **Propagate `traceparent`** on outbound requests — CF doesn't auto-propagate across service bindings.
- **Sample at the source** if event volume is high (AE has no built-in sampling in the sink).

## Relationships — why

- **recommends `analytics-engine`** (metrics backend, behind `count-store`/an AnalyticsSink), **`structured-logging`** (the logs pillar), **`sentry`** (errors → traces). A pattern, composes over whatever stack is present.
