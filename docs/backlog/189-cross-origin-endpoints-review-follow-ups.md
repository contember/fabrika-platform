---
id: 189
title: Cross-origin endpoints review follow-ups
blocked-by: []
---

# 189 — Cross-origin endpoints review follow-ups

**Summary.** Four non-blocking findings of the cross-origin endpoints review (ADR-0022 "Cross-origin endpoints"):
an `http://` rule the code does not enforce, a missing `Vary: Origin`, a late failure on an old namespace proxy pin,
and a fixed request-header list.

## Problem

1. **`http://` is admitted for any host.** ADR-0022 and the `fabrika control` help say an environment lists `http://`
   only for a local host. `isCrossOrigin` (`packages/proxy-core/src/headers.ts`) admits `http:` for every literal host.
2. **No `Vary: Origin` when the origin is not admitted.** An `environment` row answers an admitted origin with
   `Access-Control-Allow-Origin` and `Vary: Origin`, and any other request without either. A shared cache can then
   serve the second answer to a listed origin, which the browser refuses. Nothing crosses: availability only.
3. **An old Zerops namespace proxy pin fails late.** A proxy built from a source pin older than the release that added
   cross-origin endpoints refuses a manifest with `crossOrigins` or a row's `crossOrigin`. The operator step is
   documented (`docs/reference/deployment-namespaces.md`), but nothing refuses the list or the approval early: the
   failure appears at the proxy build, and every republish of the namespace fails until the pin moves.
4. **The preflight admits only `Authorization` and `Content-Type`.** A page that sends another request header (for
   example a browser SDK's tracing headers) is refused by the browser's preflight check.

## Approach / acceptance

1. Enforce a loopback host for `http:` in `isCrossOrigin` (and therefore Control, the manifest parser and both
   providers), or reword the ADR and the CLI help. A Control registry test witnesses the chosen rule.
2. Add `Vary: Origin` to every answer of an `environment` row, admitted or not, in the decision's output and in both
   compositions. The cross-origin matrix and the Caddy live test witness it.
3. Decide whether Control or the Zerops provider can tell that a namespace pin predates the fields and refuse the put
   or name the re-pin in the error.
4. Decide whether a contract may name extra request headers for a cross-origin endpoint, or keep the fixed list.

## Touch points

`packages/proxy-core/src/headers.ts`, `packages/proxy-core/src/authorize.ts`, `packages/proxy/src/caddy.ts`,
`packages/provider-cloudflare/src/proxy-worker.ts`, `packages/provider-zerops/src/namespace/`,
`docs/decisions/0022-the-proxy-is-the-only-enforcement-point.md`.

<!-- Origin: the review of the cross-origin endpoints change (issue #6). -->
