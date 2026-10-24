---
id: 100
title: A principal in many scopes gets no token
blocked-by: []
---

# 100 — A principal in many scopes gets no token

**Summary.** A token carries one permission entry per action and scope. The token bound is now 32 KiB, which fits about
200 entries: a three-action role in about 65 workspaces. Beyond that a user is still refused everywhere, and a `Within` of 1000 values
is a second ceiling behind it. What is left needs a compact claim shape and a decision on large lists; medium to large
effort.

## Problem

- `perms` is a flat `PermissionEntry[]` (`packages/auth-core/src/types.ts`), one `{ action, scope, source }` per
  action per scope value. A contract application lists exact actions, never a wildcard, so a role of three actions
  in one workspace is three entries.
- IAM signs no token above `MAX_ACCESS_TOKEN_BYTES` (32768, `packages/auth-core/src/token.ts`; `boundedToken`,
  `packages/iam/src/tokens.ts`), and the proxy turns `token_too_large` into a 403. The bound was raised from 8 KiB:
  Bun, the application runtime on Zerops, is started with `--max-http-header-size` at twice the bound
  (`packages/provider-zerops/src/execution.ts`), and Caddy (1 MiB) and Cloudflare (128 KiB) allow more. A token with a
  UUIDv7 scope value per entry passes 32 KiB at about 200 entries (it passed 8 KiB at about 50).
- Behind it, a `Within` carries at most `MAX_WITHIN_VALUES` (1000) scope values, its own, its containers' and its
  contained grants' together (`packages/db/src/capability.ts`). The framework refuses to mint a larger one
  (`packages/app/src/implement/capability.ts`), the layer refuses to use one (`packages/db/src/store.ts`), and the
  caller gets a 403 (`packages/app/src/implement/dispatch.ts`). Each value is one bound parameter, and `Bun.SQL` binds
  no array.

## Approach / acceptance

- Decide a compact claim shape for principals in hundreds of scopes, such as entries grouped by scope. It must keep
  `permits` in `@fabrika/auth-core` the one matcher the proxy and the application share (ADR-0022), and change the
  protocol additively (ADR-0062): verifiers of every framework release in the window still read `perms`.
- Decide what an `over` list does past 1000 values: a paged answer over the scope values, or a statement shape that
  is not one parameter per value.
- Witness: a user with a three-action role in 500 workspaces gets a token and lists the notes of all of them; the
  test at `packages/app/src/__tests__/locators.test.ts` changes from 403 to the decided answer.

## Touch points

`packages/auth-core` (claims, `permits`), `packages/iam/src/tokens.ts`, `packages/iam/src/resolve.ts`,
`packages/proxy-core`, `packages/app/src/implement/capability.ts`, `packages/app/src/implement/dispatch.ts`,
`packages/db/src/store.ts`, `docs/reference/application-runtime.md`.

<!-- Origin: the Within cap, deferred from A10 (docs/archive/sprint-2026-10-08-a-m2-data.md); the token bound is B5's. -->
