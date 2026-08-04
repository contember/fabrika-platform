---
id: 52
title: Let an operator revoke sessions they no longer trust
blocked-by: []
---

# 52 — Let an operator revoke sessions they no longer trust

**Summary.** Turning off `LOCAL_DEV_LOGIN` does not revoke the sessions it minted,
and nothing in the admin surface can revoke another principal's session at all. An
installation that moves from the dev-login bypass to real authentication keeps
handing out full access for up to thirty days, silently.

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

Two pieces, and the first is worth doing even alone:

1. **An admin surface for sessions.** List a principal's sessions (method, created,
   last-seen coordinates already on the row) and revoke one or all of them. Revoking
   a parent already cascades to the app sessions derived from it, so this is one call
   and not a sweep.
2. **Refuse to keep dev-bypass sessions once the bypass is off.** A session records
   how it was created; `local_login` sessions could be rejected at use when
   `localDevLogin` is false, which needs no new operator action and closes the window
   at the moment the configuration changes rather than 30 days later.

Consider whether (2) generalises: an OIDC session after OIDC is disabled has the same
shape of problem.

## Acceptance

An operator can see and revoke a named principal's sessions; a session minted by the
dev bypass stops working the moment the bypass is turned off; and neither path can
revoke a session belonging to a principal the caller may not administer.

<!-- Origin: sprint exchange-token-sso, 2026-08-04; found when the live demo signed a browser in with no password. -->
