---
id: 262
title: Re-verify the Box release facts on a live host
blocked-by: []
---

# 262 — Re-verify the Box release facts on a live host

**Summary.** The dev sandboxes now rely on four Box behaviours that come from its 2026-10 release notes and that no
test has seen on a real host. Small; needs a Box host and its key.

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

## Touch points

- `packages/provider-zerops/src/__tests__/zbox.live.test.ts`
- `docs/reference/zerops-platform.md`
