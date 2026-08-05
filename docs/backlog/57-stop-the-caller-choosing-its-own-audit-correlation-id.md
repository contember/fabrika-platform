---
id: 57
title: Stop the caller choosing its own audit correlation id
blocked-by: []
---

# 57 — Stop the caller choosing its own audit correlation id

**Summary.** IAM takes `X-Request-Id` straight from the request, unvalidated and unbounded, and
writes it into `auth_log`. On Cloudflare that request reaches IAM from the edge rather than
through the proxy, so the strip that exists to prevent exactly this never runs in front of it.

## Problem

`packages/iam/src/request-id.ts:11`:

```ts
return headerValue(request.headers, REQUEST_ID_HEADER)
	?? headerValue(request.headers, CLOUDFLARE_REQUEST_ID_HEADER) ?? generate()
```

No length cap, no character validation. The proxy deletes `X-Request-Id` at ingress and re-injects
its own — `stripClientAsserted` on Cloudflare, the `headers` handler in the generated Caddy route —
precisely because a client-chosen correlation id lands in IAM's audit trail. But IAM's own Worker
holds a Custom Domain (`packages/iam/fabrika.config.ts`), so it is edge-routed and no proxy hop
runs in front of it. A caller addressing IAM directly picks the id.

What that buys an attacker is modest and real: collide with another caller's trail to make
forensics harder, or write an arbitrarily long value into the audit table.

This is the same class as the client coordinate that WU-C fixed, and it is why the coordinate is
read from a header the ingress overwrites rather than one the caller can write. The request id
never got the same treatment.

## Approach

The composition-root pattern from `packages/iam/src/client-address.ts` already answers this: IAM
should not decide which header it may trust, the root should name it. On Cloudflare that means
preferring `cf-ray` (the edge writes it) over a caller-supplied `X-Request-Id`, or naming no
trusted header and generating. Whatever is accepted needs a length cap and a character allowlist
regardless — an audit column should never take an unbounded caller string.

Check the same question for the other services that read a forwarded correlation id.

## Acceptance

A caller cannot choose the correlation id that lands in `auth_log` on either composition, and no
unvalidated caller string reaches an audit column.

<!-- Origin: sprint auth-track-closeout, 2026-08-05; found while reviewing WU-C's header ownership table. -->
