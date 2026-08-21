---
id: 83
title: A proxy target registers without the domain its deploy needs
blocked-by: []
---

# 83 — A proxy target registers without the domain its deploy needs

**Summary.** `register` and `apps environments put` accept a Zerops manifest with a `target.proxy` and
no `domain`; the first deploy then fails at proxy composition with "requires a public domain". The
refusal belongs at registration, and the namespace should say which hosts it can serve. Effort S.

## Problem

Observed on the 2026-08-21 live rebuild: `fabrika control register --provider=zerops --namespace=<id>`
without `--domain` succeeded, created the app service in the namespace project, and the first
`deploy` failed in seconds with `Zerops proxy target <app>/<env> requires a public domain`
(`packages/control/src/node/zerops-proxy.ts`). Nothing at registration time said a domain was needed,
and nothing told the operator what to pass: for a `zerops-subdomain` namespace the only valid hosts are
the proxy's generated `proxy-<hash>-<port>.<region>.zerops.app` names, one per listening port, which
the operator had to read off the proxy service's `zeropsSubdomain` variable by hand.

## Approach / acceptance

1. Registration and environment PUT refuse a proxy-target manifest whose environment carries no
   `domain`, with a 400 naming the flag — before the provider import, so nothing is created.
2. The namespace presentation (`namespaces get`, the console detail) lists the hosts a
   `zerops-subdomain` namespace can serve once its proxy is published, read from the live proxy service,
   so an operator can copy one into `--domain`.
3. Witness: a control test registering a proxy-target manifest without a domain asserts the 400 and
   that the provider's `prepareRegistration` was not called; a provider-zerops test asserts the hosts in
   the presentation.

## Touch points

`packages/control/src/api/registry.ts`, `packages/provider-zerops/src/namespace.ts` (presentation),
`packages/cli/src/control.ts` (help text), `packages/dashboard/src/routes/namespaces/detail.tsx`,
`docs/reference/deployment-namespaces.md`.

<!-- Origin: cheap-rebuild sprint WU8 run log, 2026-08-21. -->
