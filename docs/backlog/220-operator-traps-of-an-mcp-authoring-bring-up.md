---
id: 220
title: Operator traps found bringing up MCP authoring on a real installation
blocked-by: []
---

# 220 — Operator traps found bringing up MCP authoring on a real installation

**Summary.** A first bring-up of MCP authoring on a light Zerops installation (2026-10-21) reached a working Claude
session, a stage deploy and a pull request. On the way it hit five traps that the code or the console should prevent
or explain.

## Problem

1. **`apps environments put` before the first deploy loses the bucket provenance.** `register` records the buckets its
   import created as `createdBuckets` in the stored target. A `put` sends an empty target, which replaces the stored
   one, so `createdBuckets` is gone. The first deploy's import then creates nothing, and `verify-exposure` refuses the
   bucket as unproven. The remedy in the refusal works, but an operator should never need it.
2. **`authoring` has no CLI flag and no console control.** `PutAppEnvRequest.authoring` exists, but
   `fabrika control apps environments put` cannot send it and the console does not show it. Only a hand-written RPC
   call can mark an authoring target, which is also how trap 1 was hit.
3. **A signed-in person without an application role sees a bare `forbidden`.** The installation's `admin` grant holds
   no application action, so the first thing an administrator sees on a stage URL is a plain-text `forbidden` with no
   hint that an application grant is missing.
4. **The grant dialog offers `admin` for a contract application.** Picking it fails with "role 'admin' lists the
   wildcard * and cannot be granted in a contract application". The dialog should list only roles the application
   can take.
5. **A namespace's environment must equal the application environment's name.** `register` refuses with "deployment
   namespace belongs to environment <name>", but neither the guide nor `namespaces create --help` says so before the
   namespace is created.

## Approach / acceptance

1. `put` keeps the stored `createdBuckets` (and any other recorded provider state) when it rediscovers the target.
   Test: register, put, deploy succeeds without an operator step.
2. A `--authoring=<true|false>` flag on `apps environments put`, and the flag shown and editable on the environment
   in the console, with the same refusals as the RPC.
3. The proxy's refusal for a signed-in principal without any grant on the application renders a page that names the
   missing application grant, without leaking which actions exist.
4. The grant dialog lists, for a contract application, only the roles its contract declares.
5. The guide (step 5.1) and `namespaces create --help` state that the namespace's `--env` must equal the application
   environment it will serve.

## Touch points

`packages/control/src/api/` (environment put, target discovery), `packages/cli/src/control.ts`,
`packages/dashboard/`, `packages/proxy-core/` (refusal page), `packages/provider-zerops/src/installation/guide.md`.

<!-- Origin: the MCP authoring acceptance bring-up on a real Zerops account. -->
