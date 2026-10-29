---
id: 254
title: Confirm that the sandbox host's subdomain does not publish the Box router
blocked-by: []
---

# 254 — Confirm that the sandbox host's subdomain does not publish the Box router

**Summary.** Control reaches the Box API of a namespace's sandbox host over the `zerops.app` subdomain the platform
publishes for port 8080. Whether that subdomain also publishes the router on port 8081 was not checked. Small.

## Problem

`ensureSubdomainAccess` (`packages/provider-zerops/src/namespace/sandbox-host.ts`) enables subdomain access on the `zbox`
service, and the platform publishes a subdomain per HTTP port it finds. If it publishes 8081 too, anyone can reach a
sandbox's application at `<port>-<sandbox id>` behind that subdomain without the namespace proxy. The application's
proxy-secret check still refuses such a request, so this is defence in depth, not an open door.

## Approach / acceptance

Against a real Box host, read the subdomains the service publishes after the step. If 8081 is among them, keep only the
API port public (or refuse the host) and record the fact in [platform facts](../reference/zerops-platform.md). Test: the
live suite (`zbox.live.test.ts`) asserts the published ports.

## Touch points

- `packages/provider-zerops/src/namespace/sandbox-host.ts`
- `docs/reference/zerops-platform.md`
