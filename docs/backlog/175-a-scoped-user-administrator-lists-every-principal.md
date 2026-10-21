---
id: 175
title: A scoped user administrator lists every principal
blocked-by: []
---

# 175 — A scoped user administrator lists every principal

**Summary.** A user administrator scoped to one application reads the whole installation's directory and the
sessions of anyone in it. Narrow its reads to the people of its scope.

## Problem

[ADR-0058](../decisions/0058-user-administration-is-grantable-on-its-own.md) scopes a user administrator's writes to
the applications of its `app` scope, and keeps its reads installation-wide. `principals.list` and `principals.get`
answer every principal, with their mailboxes and their grants at other applications and at the installation's own
apps. A scoped user administrator needs to find a person to grant to, but it does not need everyone's grants.

`sessions.list` reads more than a directory entry. `listSessionsUseCase` (`packages/iam/src/admin/sessions.ts:53-66`)
checks only that the principal exists, so a scoped user administrator lists the sessions of an installation admin, a
deployer or another user administrator: how each signed in, the apps it uses, and when. `sessions.revoke` and
`revokeAll` call `requireActableTarget` (`sessions.ts:84`, `:109`); the listing does not. ADR-0058 §5 lists
`sessions.*` among the acts on a principal that need the target check.

## Approach / acceptance

Decide what a scoped user administrator finds a person by (a mailbox lookup, as `appPeople.grant` takes, or a listing
of the people holding a grant in its scope), and hide grants outside its scope from `principals.get`. Make
`sessions.list` call `requireActableTarget` as its siblings do. Witness: a user administrator scoped to one
application reads no grant of another application, and its `sessions.list` of an installation admin answers 403
(`admin-rpc-gates.test.ts`).

## Touch points

`packages/iam/src/admin/principals.ts`, `packages/iam/src/admin/sessions.ts`, `packages/iam/src/admin/rpc.ts`, the
dashboard's People view.
