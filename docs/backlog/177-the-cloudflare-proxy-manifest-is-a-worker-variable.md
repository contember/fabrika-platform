---
id: 177
title: The Cloudflare proxy manifest is a Worker variable, which Cloudflare caps at 5 KB
blocked-by: []
---

# 177 — The Cloudflare proxy manifest is a Worker variable, which Cloudflare caps at 5 KB

**Summary.** A contract application of more than about a dozen endpoints may not deploy on Cloudflare: its proxy
Worker carries the endpoint table as a `vars` entry, and Cloudflare documents 5 KB per variable. Release-relevant
for any real Cloudflare application; medium effort.

## Problem

`createCloudflareProxyWorker` (`packages/provider-cloudflare/src/proxy.ts`) writes the application's whole proxy
manifest into the proxy Worker as `vars.FABRIKA_PROXY_MANIFEST_JSON`, and `proxy-worker.ts` parses it from `env` per
isolate. Cloudflare's [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) list "Variable
size: 5 KB" on the Free and Paid plans alike, for text and secret variables both. A manifest row costs about 385
bytes of JSON (measured on `examples/crm`, issue #3), so the cap is reached at roughly 13 endpoints: `examples/crm`
as one proxy manifest is 13,231 bytes; `examples/app`, the only Cloudflare example, is 1,612. Not yet measured
against a real account: whether `wrangler deploy` refuses an oversized plain-text variable, and with what message.

On Zerops the same table travelled in a service variable capped at ~32 KB, and now travels as a data file of the
proxy's build archive (ADR-0045). Cloudflare should follow the same model: the manifest is baked into the artifact.

## Approach / acceptance

- Measure first: deploy a proxy Worker whose manifest variable is 5 KB + 1 byte, and record the result in
  `docs/reference/` beside the other Cloudflare facts.
- Bake the manifest into the proxy Worker bundle as a JSON module generated per deploy (the Worker size limit is
  64 MiB), imported by the proxy entrypoint and parsed with the same strict `parseProxyManifest`; drop the variable.
  The proxy Worker is built from this package's own entrypoint in the runner image (ADR-0048), so the generated
  module lives beside the generated wrangler config, and `bounds.ts` must admit exactly that one file.
- Witness: a deploy test with a manifest past 5 KB (and a synthetic one past 1 MB) whose generated Worker serves it;
  `packages/local-stack/__tests__/proxy-tables.test.ts` reads the baked manifest instead of `vars`.

## Touch points

`packages/provider-cloudflare/src/proxy.ts`, `proxy-worker.ts`, `bounds.ts`, the runner's deploy step,
`packages/local-stack/__tests__/proxy-tables.test.ts`, ADR-0022 ("On Cloudflare it is a Worker variable").

<!-- Origin: issue #3 (the Zerops ~32 KB service variable limit) and its follow-up. -->
