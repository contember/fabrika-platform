---
id: 262
title: Re-verify the Box release facts on a live host
blocked-by: []
---

# 262 — Re-verify the Box release facts on a live host

**Summary.** The dev sandboxes now rely on four Box behaviours that come from its 2026-10 release notes and that no
test has seen on a real host, and four follow-ups wait on the answers. Small; needs a Box host and its key.

## Problem

[Platform facts](../reference/zerops-platform.md) marks the 2026-10 release rows UNVERIFIED. Four of them carry code:

1. The router routes the bare `Host: 3000-<sandbox id>`: the provider no longer adds a workspace domain
   (`packages/provider-zerops/src/sandbox-host.ts`), so a router without it answers `NO_ROUTE` for every sandbox.
2. A `PROJECT`-access port refuses a request carrying `X-Forwarded-For`: the namespace proxy drops it on a sandbox hop
   (`packages/proxy/src/caddy.ts`).
3. `Authorization` reaches the sandbox: a key caller's `POST` and a bearer-verified webhook work in a dev sandbox
   (`docs/reference/mcp-authoring.md`).
4. A sandbox past its absolute TTL reads `ARCHIVED`, and a create that names no TTL gets none: `ensure` replaces an
   `ARCHIVED` sandbox (`packages/provider-zerops/src/sandbox/lifecycle.ts`), but a default TTL would end every
   workspace sandbox on a schedule nobody chose.

The live suite (`zbox.live.test.ts`) checks the lifecycle over the API only; it never sends a request through the router.

## Approach / acceptance

Against a real host on the new release: read a created sandbox's `idleTtlSeconds` and `absoluteTtlSeconds` in the live
suite and assert both are `0`, or send `0` at create if they are not. From a service in the same project, send a request
with the bare Host to a sandbox's `PROJECT` port, with and without `X-Forwarded-For`, and with `Authorization`; record
each answer in platform facts and drop the UNVERIFIED mark of the rows that hold.

Then settle what the review of the change that adopted the release left open:

1. If the bare Host does not route, restore the DOT domain step and the dotted `upstreamHost`.
2. Send `idleTtlSeconds: 0` and `absoluteTtlSeconds: 0` at create if a create without them gets a TTL, and tell the
   operator to clear the TTLs of existing sandboxes (`zbox set <id> --absolute-ttl 0 --idle-ttl 0`): the absolute TTL
   deletes the sandbox's disk, its database included.
3. `findSandboxByName` takes the first sandbox of the name. Box lists an ended sandbox for 7 days, so after an `ARCHIVED`
   one is replaced, an ended record listed first makes `ensure` delete it again and create under a name the live sandbox
   holds. Prefer a sandbox that has not ended. Test: a list with an ended and a live sandbox of one name finds the live one.
4. Document the operator steps the release asks for: one reload of the `zbox` service (until then a restart, such as
   the rekey's, still drops the memory of running sandboxes), and the new Box agent, which a base Fabrika built earlier
   does not get, because the base is found by its content name.

## Touch points

- `packages/provider-zerops/src/__tests__/zbox.live.test.ts`
- `packages/provider-zerops/src/zbox/client.ts`
- `packages/provider-zerops/src/sandbox-host.ts`, `src/namespace/sandbox-host.ts`
- `docs/reference/zerops-platform.md`
