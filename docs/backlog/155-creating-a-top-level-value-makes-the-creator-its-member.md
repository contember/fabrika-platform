---
id: 155
title: Creating a top-level value makes the creator its member
blocked-by: []
---

# 155 — Creating a top-level value makes the creator its member

**Summary.** `creates` requires a creator role and grants it to the caller. A staff role that creates partner
organizations and then invites their people becomes a member of each one, and the last creator cannot be removed.
Effort: S–M; it needs a decision first.

## Problem

- The build refuses `creates` on a dimension without a creator role (`packages/app/src/contract/build.ts:826`), and
  `createScope` grants it atomically (`packages/app/src/implement/membership.ts:185`–`:187`); removing the last
  holder answers 409 (`:134`–`:135`).
- `app: true` writes application tables only, so it cannot insert the dimension row either.
- IAM does not need the value to exist before `assignMember` (`packages/iam/src/membership.ts`): the value's id can be
  the application's own UUID.
- An application built on the paved road creates the value under `app: true` with `unscoped: { <table>: 'write' }`, a
  declared deviation, then invites its people.

## Approach / acceptance

- Decide a form for "create a top-level value without joining it": `creates` with no creator for a global holder of
  the action, or an `app` capability that inserts a top-level dimension row.
- Witness: a global holder creates a value and invites its first member; the creator holds no role in it, and no
  `unscoped` is declared.

## Touch points

`packages/app/src/contract/{build.ts,define.ts}`, `packages/app/src/implement/membership.ts`, `packages/db/src/orm.ts`,
`packages/app/skill/references/endpoint.md`, `docs/decisions/0012-fabrika-app-runtime.md`.
