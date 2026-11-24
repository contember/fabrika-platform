---
id: 231
title: Operator traps found bringing up MCP authoring on a real installation
blocked-by: []
---

# 231 — Operator traps found bringing up MCP authoring on a real installation

**Summary.** A first bring-up of MCP authoring on a light Zerops installation (2026-10-21) reached a working Claude
session, a stage deploy and a pull request. On the way it hit five traps that the code or the console should prevent
or explain.

## Problem

1. **`apps environments put` before the first deploy loses the bucket provenance.** `register` records the buckets its
   import created as `createdBuckets` in the stored target. A `put` sends an empty target, which replaces the stored
   one, so `createdBuckets` is gone. The first deploy's import then creates nothing, and `verify-exposure` refuses the
   bucket as unproven. The remedy in the refusal works, but an operator should never need it.
2. _Done:_ `fabrika control apps environments put --authoring=<true|false>` and the environment form's _MCP authoring
   target_ checkbox send `PutAppEnvRequest.authoring`.
3. **A signed-in person without an application role sees a bare `forbidden`.** The installation's `admin` grant holds
   no application action, so the first thing an administrator sees on a stage URL is a plain-text `forbidden` with no
   hint that an application grant is missing.
4. **The grant dialog offers `admin` on an API key at a contract application.** IAM gives a contract application's
   `admin` to a person, as its declared actions (ADR-0022 rule 6), and refuses it to a key: "role 'admin' is granted
   only to a person in a contract application". The key's grant page should not offer it.
5. **A namespace's environment must equal the application environment's name.** `register` refuses with "deployment
   namespace belongs to environment <name>", but neither the guide nor `namespaces create --help` says so before the
   namespace is created.

## Approach / acceptance

1. `put` keeps the stored `createdBuckets` (and any other recorded provider state) when it rediscovers the target.
   Test: register, put, deploy succeeds without an operator step.
2. Done (see above).
3. The proxy's refusal for a signed-in principal without any grant on the application renders a page that names the
   missing application grant, without leaking which actions exist.
4. A key's grant page at a contract application lists only the roles its contract declares, never `admin`.
5. The guide (step 5.1) and `namespaces create --help` state that the namespace's `--env` must equal the application
   environment it will serve.

## Touch points

`packages/control/src/api/` (environment put, target discovery), `packages/cli/src/control.ts`,
`packages/dashboard/`, `packages/proxy-core/` (refusal page), `packages/provider-zerops/src/installation/guide.md`.

<!-- Origin: the MCP authoring acceptance bring-up on a real Zerops account. -->
