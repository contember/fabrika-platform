---
id: 80
title: Harmonize the admin RPC principal inputs
blocked-by: []
---

# 80 — Harmonize the admin RPC principal inputs

**Summary.** Two admin-RPC procedures name the same principal by two different keys, so the obvious
call against one of them answers `400 id: Required`. Effort S.

## Problem

`grants.create` takes `CreateGrantRequest`, which keys on `principalId`
(`packages/iam-contract/src/index.ts`, the `CreateGrantRequest` interface). `principals.get`,
`principals.delete`, `sessions.revokeAll` and all three `passwords.*` procedures take
`PrincipalIdInput`, which keys on `id`. `apiKeys.*` takes `ApiKeyIdInput`, which keys on
`principalId` again. Nothing in the contract says which spelling a given procedure wants, so a caller
writing the natural sequence — create a grant for a principal, then issue that principal an
enrollment — sends `principalId` twice and the second call is refused.

This was found by hand on 2026-08-10 while admitting the first administrator to a live installation,
and again while building the command that replaced that hand sequence.

**A caller hides it today.** `ensureFirstAdministrator`
(`packages/installation-init/src/admin.ts`) sends `principalId` to `grants.create` and `id` to
`principals.get` and `passwords.issueEnrollment`, with a comment saying why. That was the deliberate
choice for the command — a contract change would have meant a migration for the console in the same
work — but it fixes the surface for exactly one caller. The console, `iam-ui` and any future
operator tooling each meet the difference on their own.

## Approach / acceptance

Pick ONE spelling for "the principal this call is about" across `IamAdminRpcContract`, change the
inputs that disagree, and move every caller in the same change: `packages/iam/src/admin/rpc.ts`'s zod
schemas, `packages/iam/src/admin/handlers.ts`, `packages/iam-ui/`, `packages/dashboard/` and
`packages/installation-init/src/admin.ts` — whose hiding comment then comes out. It is a breaking
change to a published contract, so it needs a version note rather than a quiet edit.

Acceptance: every procedure that names a principal takes the same key, a test asserts it across the
contract rather than per procedure, and the first-administrator command sends one shape.

## Touch points

`packages/iam-contract/src/index.ts`, `packages/iam/src/admin/{rpc,handlers}.ts`,
`packages/iam-ui/`, `packages/dashboard/`, `packages/installation-init/src/admin.ts`.

<!-- Origin: sprint-2026-08-21-cheap-rebuild-from-scratch, WU3 — the decision to hide the difference in the command. -->
