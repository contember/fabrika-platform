---
id: 174
title: Grant user administration on its own
blocked-by: []
---

# 174 — Grant user administration on its own

**Summary.** Build [ADR-0058](../decisions/0058-user-administration-is-grantable-on-its-own.md): the `user-admin`
role at `propustka`, which manages the people of the applications and stops at the installation.

## Problem

Every `/admin/rpc` procedure requires `iam.admin` (`packages/iam/src/admin/rpc.ts:41-203`), and only the built-in
`admin` or a bootstrap mailbox holds it. An operator cannot give anyone user management without the whole
installation. On Cloudflare, a platform deploy registers no vocabulary with IAM at all: its `reconcile-schema` step
writes a runner outcome file that exists only inside the runner.

## Approach / acceptance

1. **Cloudflare first, in its own commit.** A platform deploy reconciles a component's schema with IAM directly, with
   the provisioning key. IAM's own config declares no schema. The scaffolded workflow names the console's return
   origin. Witness: a platform deploy of a component with a schema calls IAM, and an application deploy still only
   reports its schema.
2. **The vocabulary** (`IAM_APP_SCHEMA` in `@fabrika/iam-contract`), registered beside the console on Zerops,
   Cloudflare and the local stack.
3. **IAM gates and rules** (ADR-0058 sections 2–5, 7): a gate that admits a global or scoped `iam.users.manage` from
   a session, grants only at non-installation apps in scope, actions only on principals whose every grant the caller
   could have made, the manual-URL rule, access rows and `privileged`. Witness: one test per refusal — `admin`
   cross-app, a grant at `vozka` or `propustka`, a reset of a console admin, a disable of an IAM admin, a scoped user
   admin at another app, a reset URL without email, a `px_` key — on SQLite and Postgres.
4. **The console**: `me.permissions` decides the Access section, a user admin sees People, and the grant form offers
   only non-installation apps in the caller's scope.

## Touch points

`packages/iam-contract`, `packages/iam/src/admin/`, `packages/iam/src/auth/sessions.ts`,
`packages/provider-cloudflare/src/{provider,command}.ts`, `packages/provider-cloudflare/src/installation/`,
`packages/provider-zerops/src/installation/deploy.ts`, `packages/local-stack/src/app-registration.ts`,
`packages/dashboard/src/`.
