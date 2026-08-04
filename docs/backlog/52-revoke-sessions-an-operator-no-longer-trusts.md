---
id: 52
title: Let an operator revoke sessions they no longer trust
blocked-by: []
---

# 52 — Let an operator revoke sessions they no longer trust

**Summary.** Nothing in the admin surface can revoke another principal's session.
Only the session's own holder can, through `/auth/logout`, so an operator's answer
to "this session should not exist" is to disable the whole principal.

> The dev-bypass half of this is **fixed** (`packages/iam/src/auth.ts`,
> `isDevBypassSession`): a session minted by `LOCAL_DEV_LOGIN` is refused at use once
> the flag is off, so that window closes when the configuration changes rather than
> thirty days later. What remains is the general case below.

## Problem

`LOCAL_DEV_LOGIN` creates a **real** session row for a fixed global-admin principal
(`LOCAL_DEV_ADMIN_ID`, `packages/iam/src/auth.ts`), with the ordinary 30-day
lifetime. Flipping the flag off — or moving `ENVIRONMENT` off `local` — changes what
the _next_ request can do and nothing about what has already been issued.

Observed on `fabrika-test` on 2026-08-04. The installation was switched to
password-only authentication that morning; the auth log still shows five
`local_login` sessions from the bring-up the day before, and a browser holding one
walks straight through the new cross-host handoff with no password, because an
existing IAM session is exactly what makes a handoff silent (ADR-0021). Everything
behaved as designed; the design just has no way to say "not those".

The second half is the one that bites generally: **only the session's own holder can
revoke it.** `revokeSessionByHash` is reached from `/auth/logout` and nowhere else
(`packages/iam/src/auth/routes.ts`). `listSessionsForPrincipal` exists in the
repository and has no caller. Disabling a password revokes password sessions only,
by design. So the operator answer to "this session should not exist" is currently
"disable the whole principal", which also locks out the person.

## Approach

**An admin surface for sessions.** List a principal's sessions (`authentication_method`,
`created_at` and the app binding are already on the row) and revoke one or all of them.
Revoking a parent already cascades to every app session derived from it, so this is one
call and not a sweep.

The shipped dev-bypass check suggests a generalisation worth considering with it: an
OIDC session after OIDC is disabled has the same shape of problem, and the same answer
— refuse at use, not at creation.

## Acceptance

An operator can see and revoke a named principal's sessions, and cannot revoke one
belonging to a principal they may not administer.

<!-- Origin: sprint exchange-token-sso, 2026-08-04; found when the live demo signed a browser in with no password. -->
