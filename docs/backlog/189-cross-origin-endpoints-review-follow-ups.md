---
id: 189
title: Cross-origin endpoints review follow-ups
blocked-by: []
---

# 189 — Cross-origin endpoints review follow-ups

**Summary.** Four non-blocking findings of the cross-origin endpoints review (ADR-0022 "Cross-origin endpoints"):
an `http://` rule the code does not enforce, a missing `Vary: Origin`, a namespace proxy pin whose release Control
does not record, and a fixed request-header list.

## Problem

1. **`http://` is admitted for any host.** ADR-0022 and the `fabrika control` help say an environment lists `http://`
   only for a local host. `isCrossOrigin` (`packages/proxy-core/src/headers.ts`) admits `http:` for every literal host.
2. **No `Vary: Origin` when the origin is not admitted.** An `environment` row answers an admitted origin with
   `Access-Control-Allow-Origin` and `Vary: Origin`, and any other request without either. A shared cache can then
   serve the second answer to a listed origin, which the browser refuses. Nothing crosses: availability only.
3. **Control does not record a namespace proxy pin's release.** `ZeropsNamespaceProxySource`
   (`packages/provider-zerops/src/namespace/types.ts:11`) holds a repository, a commit and a descriptor, and no
   release. Three consequences:
   - A proxy built from a pin older than 0.5.3 refuses a manifest with `crossOrigins` or a row's `crossOrigin`. The
     operator step is documented (`docs/reference/deployment-namespaces.md`), but nothing refuses the list or the
     approval early: the failure appears at the proxy build (`generate-config.ts` exits 1), and every republish of the
     namespace fails until the pin moves (backlog 193 #8). `upgrade` does not move a pin, so an upgraded installation
     keeps its old pins.
   - `entriesNeedingCurrentProxy` (`packages/provider-zerops/src/namespace/proxy-reads.ts:29-34`) admits a row when
     ANY reader of `OLDER_PROXY_READERS` (`packages/control/src/zerops/older-proxies.ts:24`) parses it. So the newest
     reader of the window decides for every older pin, and only a window that holds no reader newer than the pin is
     safe. The 0.7 reader therefore stays out of the window until this is fixed.
   - Rows and CSP are judged separately by "any" reader: one release may accept the rows and another the CSP, so an
     entry passes that no single release's proxy parses. It cannot happen with today's readers (P3).
4. **The preflight admits only `Authorization` and `Content-Type`.** A page that sends another request header (for
   example a browser SDK's tracing headers) is refused by the browser's preflight check.

## Approach / acceptance

1. Enforce a loopback host for `http:` in `isCrossOrigin` (and therefore Control, the manifest parser and both
   providers), or reword the ADR and the CLI help. A Control registry test witnesses the chosen rule.
2. Add `Vary: Origin` to every answer of an `environment` row, admitted or not, in the decision's output and in both
   compositions. The cross-origin matrix and the Caddy live test witness it.
3. Know a pin's release and judge the whole entry, rows and CSP, with that one release's parser
   (`OlderProxyReaders` becomes a map from release to reader). Two options:
   - **A `release` field on `ZeropsNamespaceProxySource`**, written by `prepareNamespaceProxySource` from the
     source version (size M). Additive, but `namespaceProxySourceSchema` is `.strict()`
     (`packages/provider-zerops/src/namespace/proxy-source.ts:7-11`): a Control rolled back to an older release refuses
     the stored target. A pin without the field (every pin of an existing installation) is judged by the oldest reader
     of the window.
   - **A bundled table from a tag's commit to its release** (size S–M). No state change, so it covers existing
     pins at once. Each release adds its own row; a pin that is no release's tag commit is judged by the oldest reader.
   - **With either**, the 0.7 reader joins the window, a pre-0.5.3 pin refuses a cross-origin field before any
     effect and names the re-pin, and the error of `assertNamespaceProxyReads` names the pin's release. Witness: a rewritten
     `packages/control/src/__tests__/older-proxies.test.ts` where a 0.6 pin refuses a `public` row and a 0.7 pin admits
     it, and `namespace-proxy-reads.test.ts` where rows that only 0.6 reads and a CSP that only 0.7 reads are refused.
     ADR-0022 ("A new row form needs a proxy that reads it") and `deployment-namespaces.md` change with it.
4. Decide whether a contract may name extra request headers for a cross-origin endpoint, or keep the fixed list.

## Touch points

`packages/proxy-core/src/headers.ts`, `packages/proxy-core/src/authorize.ts`, `packages/proxy/src/caddy.ts`,
`packages/provider-cloudflare/src/proxy-worker.ts`, `packages/provider-zerops/src/namespace/`,
`packages/control/src/zerops/older-proxies.ts`, `docs/decisions/0022-the-proxy-is-the-only-enforcement-point.md`,
`docs/reference/deployment-namespaces.md`.

<!-- Origin: the review of the cross-origin endpoints change (issue #6); item 3 extended by a later platform review. -->
