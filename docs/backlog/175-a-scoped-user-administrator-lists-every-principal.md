---
id: 175
title: A scoped user administrator lists every principal
blocked-by: []
---

# 175 — A scoped user administrator lists every principal

**Summary.** A user administrator scoped to one application reads the whole installation's directory. Narrow its
reads to the people of its scope.

## Problem

[ADR-0058](../decisions/0058-user-administration-is-grantable-on-its-own.md) scopes a user administrator's writes to
the applications of its `app` scope, and keeps its reads installation-wide. `principals.list` and `principals.get`
answer every principal, with their mailboxes and their grants at other applications and at the installation's own
apps. A scoped user administrator needs to find a person to grant to, but it does not need everyone's grants.

## Approach / acceptance

Decide what a scoped user administrator finds a person by (a mailbox lookup, as `appPeople.grant` takes, or a listing
of the people holding a grant in its scope), and hide grants outside its scope from `principals.get`. Witness: a user
administrator scoped to one application reads no grant of another application.

## Touch points

`packages/iam/src/admin/principals.ts`, `packages/iam/src/admin/rpc.ts`, the dashboard's People view.
