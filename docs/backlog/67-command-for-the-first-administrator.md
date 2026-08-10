---
id: 67
title: Give the first administrator a command
blocked-by: []
---

# 67 — Give the first administrator a command

**Summary.** A fresh installation comes up with nobody able to sign in, and the four RPC calls that fix
that live in a throwaway script rather than in `fabrika`. Effort S.

## Problem

`fabrika platform install` finishes by printing the provisioning key, and there the documented path
stops. Bringing the first administrator into existence on 2026-08-10 took four hand-made calls to
`/admin/rpc` — `principals.list`, `principals.invite`, `grants.create`, `passwords.issueEnrollment` —
and the enrollment URL was copied out of a terminal. Nothing in this repository does it, and nothing
tests that it still works.

Two things the hand run established that a command must carry, or it will reproduce them:

- **The grant must be cross-app (`app: null`).** Grants filter to the calling app, so an `admin` grant
  scoped to the console's own app id leaves a console where Delivery and Operations work and the Access
  plane refuses with "your session does not include `iam.admin`". IAM's own app id `propustka` is not a
  registered app, so scoping the grant to it would dangle instead.
- **The admin RPC input shape is not consistent.** `grants.create` takes `principalId`;
  `passwords.issueEnrollment` takes `PrincipalIdInput` (`iam-contract/src/index.ts:455`), which keys on
  `id`, so the obvious call returns `400 id: Required`. Either harmonize the two inputs or the command
  hides the difference — but a caller writing against the admin surface hits it either way.

The alternative — seeding `IAM_BOOTSTRAP_ADMINS` — is refused by decision: the Zerops path has no
admission hatch today precisely because nothing seeds one, and adding one would file
[64](./64-close-the-bootstrap-admission-hatch-automatically.md) against ourselves.

## Approach / acceptance

A command (or a final step of `platform install`) that takes an email, is idempotent on re-run, writes
a cross-app `admin` grant, and prints an enrollment URL exactly once. Acceptance is a live one: on a
fresh installation with no `IAM_BOOTSTRAP_ADMINS` set anywhere, the printed URL sets a password and the
resulting session reaches **all three** console planes — Access included, which is the one an app-scoped
grant silently fails.

## Touch points

`packages/installation-zerops/`, `packages/installation-contract/`, `packages/cli/`,
`packages/iam-contract/` (only if the input shapes are harmonized).

<!-- Origin: sprint-2026-08-07-zerops-from-scratch-install, WU4 run log. -->
