---
id: 256
title: A sandbox host fault fails the shared namespace
blocked-by: []
---

# 256 — A sandbox host fault fails the shared namespace

**Summary.** A Box sandbox host failure during a namespace reconcile marks the whole namespace `failed`, which refuses
every deploy of every application in it, although only dev authoring needs the host. Medium; dev namespaces only.

## Problem

`provision`/`reconcile` (`packages/provider-zerops/src/namespace/provisioning.ts`) creates the sandbox host after the
proxy converged and `ready` is checkpointed; the comment there says a host failure never holds back the namespace's
proxy. But `sandboxHost` rethrows the failure (`asNamespaceError`), and a non-retryable one (a host key Box refuses, a
Box 4xx on `PUT /workspace/domains`, a `zbox` service whose identity changed) reaches the queued reconcile in
`packages/control/src/api/namespaces.ts`, which writes the namespace `failed`. `republishUnderLease` then refuses every
deploy of the namespace's members. A namespace has a sandbox key while any dev sandbox row is `creating` or `ready`, so
every later reconcile retries the host and fails the same way until the workspace is abandoned.

A `prod` environment never shares a namespace with a dev one, so production is not affected; every application of the
dev namespace is.

## Approach / acceptance

Keep the namespace `ready` when only the host step fails: the provider reports the host failure apart from the
namespace's outcome (a result field, or a `devHostPending`-style error raised after the checkpoint that Control does not
map to `failed`), and `bind_dev` surfaces the cause to the author. A test: a reconcile whose host step fails with a Box
4xx leaves the namespace `ready`, another member's deploy still publishes, and `bind_dev` answers the host failure.

## Touch points

`packages/provider-zerops/src/namespace/provisioning.ts`, `packages/provider-zerops/src/namespace/sandbox-host.ts`,
`packages/control/src/api/namespaces.ts`, `packages/control/src/dev/service.ts`.

<!-- Origin: the comprehensive review of the per-workspace dev sandboxes PR (#84). The pin half was fixed by admitting a
sandbox's placement before its row is recorded. -->
