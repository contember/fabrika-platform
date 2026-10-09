---
id: 100
title: A principal in many scopes gets no token
blocked-by: []
---

# 100 — A principal in many scopes gets no token

**Summary.** A token carries one permission entry per action and scope, and IAM refuses to sign one above 8 KiB, so a
user in a few dozen workspaces is refused everywhere in the application. The 1000-value cap of a `Within` is a second
ceiling behind it. Needs a decision on the claim shape; medium to large effort.

## Problem

- `perms` is a flat `PermissionEntry[]` (`packages/auth-core/src/types.ts:22`), one `{ action, scope, source }` per
  action per scope value. A contract application lists exact actions, never a wildcard, so a role of three actions
  in one workspace is three entries.
- IAM signs no token above `MAX_ACCESS_TOKEN_BYTES` (8192, `packages/auth-core/src/token.ts:70`; `boundedToken`,
  `packages/iam/src/tokens.ts:229`), and the proxy turns `token_too_large` into a 403. A token with a UUIDv7 scope
  value per entry passes that bound at about 50 entries. A user with a three-action role in 17 workspaces gets no
  token, so every authenticated endpoint answers 403, not only lists.
- Behind it, a `Within` carries at most `MAX_WITHIN_VALUES` (1000) scope values, its own and its containers'
  together (`packages/db/src/capability.ts:35`). The framework refuses to mint a larger one
  (`packages/app/src/implement/capability.ts:212`), the layer refuses to use one (`packages/db/src/store.ts:230`), and
  the caller gets a 403 (`packages/app/src/implement/dispatch.ts:717`). Each value is one bound parameter, and
  `Bun.SQL` binds no array.

The plan's risk table names "scope-compressed claims later" for the first ceiling and nothing for the second.

## Approach / acceptance

- Decide the claim shape: entries grouped by scope or by role, or a token that carries the roles while the
  application resolves their actions from the artifact. The shape must keep `permits` in `@fabrika/auth-core` the one
  matcher the proxy and the application share (ADR-0022).
- Decide what an `over` list does past 1000 values: a paged answer over the scope values, or a statement shape that
  is not one parameter per value.
- Witness: a user with a three-action role in 200 workspaces gets a token and lists the notes of all of them; the
  test at `packages/app/src/__tests__/locators.test.ts:163` changes from 403 to the decided answer.

## Touch points

`packages/auth-core` (claims, `permits`), `packages/iam/src/tokens.ts`, `packages/iam/src/resolve.ts`,
`packages/proxy-core`, `packages/app/src/implement/capability.ts`, `packages/app/src/implement/dispatch.ts`,
`packages/db/src/store.ts`, `docs/reference/application-runtime.md`.

<!-- Origin: the Within cap, deferred from A10 (docs/archive/sprint-2026-10-08-a-m2-data.md); the token bound is B5's. -->
