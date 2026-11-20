---
id: 292
title: Boot every platform Worker in workerd in the test suite
blocked-by: []
---

# 292 — Boot every platform Worker in workerd in the test suite

**Summary.** Only Control's Worker is started in workerd by a test (`packages/control/src/__tests__/worker-boot.test.ts`);
IAM's, Operations' and the runner's are not, so a module-load error that only workerd refuses reaches a live deploy. P3,
size S.

## Problem

The suite runs under Bun, which evaluates code that workerd refuses at load (a `new URL(…, import.meta.url)` in an
imported module, as `@fabrika/app/build` had from v0.9.0-dev.15 to dev.18). Such a Worker fails `wrangler deploy` with
code 10021 after its resources are provisioned. The runner Worker bundles `@fabrika/provider-cloudflare` and
`@fabrika/app` as Control's does; IAM and Operations bundle other parts of `@fabrika/app`.

## Approach / acceptance

Boot each committed or generated `wrangler.jsonc` of IAM, Operations and the runner with `wrangler dev` the way the
Control test does, and expect an answer from the Worker. The runner's config declares a container, which `wrangler dev`
has to be told to skip (`--enable-containers=false` or an equivalent). Acceptance: reintroducing a module-scope
`new URL(…, import.meta.url)` into any module one of the four Workers imports fails a test.

## Touch points

`packages/control/src/__tests__/worker-boot.test.ts`, `packages/iam/`, `packages/operations/`,
`packages/runner-cloudflare/`.
