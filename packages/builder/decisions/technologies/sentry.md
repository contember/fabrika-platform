---
id: sentry
kind: technology
title: Sentry (error tracking)
slot: error-tracking
provides: [error-tracking, exception-capture, source-maps, session-replay]
requires: []
recommends: [observability]
conflicts: []
npm: ["@sentry/cloudflare", "@sentry/react", "@sentry/vite-plugin", "toucan-js"]
status: stable
sources:
  - where: "Sentry Cloudflare Workers and React SDK documentation"
    read: "SDK initialization, environment and release tags, trace propagation, logger integration, and error boundaries."
  - where: "Sentry docs: Cloudflare Workers (@sentry/cloudflare or toucan-js), source-map upload (@sentry/vite-plugin / wrangler upload_source_maps), beforeSend + fingerprinting"
    read: "Init options, source maps with SENTRY_AUTH_TOKEN, redaction, and fingerprinting for grouping."
---

# Sentry

## What it is

The error-tracking option: capture exceptions + stack traces (with source maps) and
group them. On Workers via **`@sentry/cloudflare`** (or `toucan-js` for a lighter
footprint), in the browser via **`@sentry/react`**, with source maps uploaded by
**`@sentry/vite-plugin`** or wrangler's `upload_source_maps` (gated on
`SENTRY_AUTH_TOKEN`). Plugs into `structured-logging` as a handler that forwards
`logger.error` to `captureException` at warn+.

## When & why to use

- You want managed error aggregation + alerting (and optional browser session replay) rather than building it.
- Production apps where un-grouped, un-sourcemapped stack traces aren't enough.

## When NOT to use

- You specifically want **self-hosted** error tracking (the `cf-fat`/error-tracker style — store issues in D1/DO, query via admin) for data residency/cost.
- Trivial apps where structured logs + AE metrics are enough.

## Gotchas

- **Redact in `beforeSend`** — strip auth headers / PII before send; errors easily carry secrets.
- **`enableRpcTracePropagation: true`** — or Durable Object / service-binding errors appear isolated from the originating request.
- **Source maps must be uploaded in CI** (SENTRY_AUTH_TOKEN) or stacks are minified-useless.
- **Control cardinality with `fingerprint`** — don't put request ids in the error message or grouping explodes; use intent-based fingerprints. Use `replaysOnErrorSampleRate`, not full session replay, for cost.

## Relationships — why

- **slot `error-tracking`** — the errors arm of `observability`; **recommends `observability`** (errors enrich traces/metrics). Bridged from `structured-logging` via a Sentry log handler.
