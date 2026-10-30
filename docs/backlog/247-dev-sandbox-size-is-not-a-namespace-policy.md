---
id: 247
title: A dev sandbox's size is not namespace policy
blocked-by: []
---

# 247 — A dev sandbox's size is not namespace policy

**Summary.** Every dev sandbox gets the same CPU, memory and disk, fixed in code. An operator cannot size them per
namespace, and a host fills at a fixed count of running sandboxes. Small to medium.

## Problem

`SANDBOX_CPUS` and `SANDBOX_MEMORY_BYTES` (`packages/provider-zerops/src/sandbox/constants.ts`) are constants, and a
sandbox's disk is Box's default, although Box takes a per-sandbox `diskBytes` since its 2026-10 release. A running
sandbox reserves its whole memory on the host, and Box plans no overcommit, so the constants also decide
how many sandboxes one `zbox` service runs before `bind_dev` answers that the host is full. An application whose build
or tests need more memory has no remedy.

## Approach / acceptance

Make the sandbox size part of the namespace's policy (the target the operator plans with `namespaces plan`/`create`),
with today's constants as the default, and apply it at sandbox creation. Decide whether a changed size applies to
existing sandboxes: Box changes a sandbox's size only with a cold boot, which loses its memory
([platform facts](../reference/zerops-platform.md)). Test: a namespace with a larger memory policy creates sandboxes with that `memoryBytes`.

## Touch points

- `packages/provider-zerops/src/sandbox/constants.ts`
- `packages/provider-zerops/src/sandbox/lifecycle.ts`
- `packages/provider-zerops/src/namespace/types.ts`
- `packages/cli/src/control.ts`
