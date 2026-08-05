---
id: 55
title: Refuse a session whose authentication method was turned off
blocked-by: []
---

# 55 — Refuse a session whose authentication method was turned off

**Summary.** Disabling OIDC (or password) changes what the _next_ login may do and
nothing about the sessions already issued. The dev bypass already solves exactly this
shape; generalising the check is small, but one detail makes it a trap rather than a
one-liner.

## Problem

`isDevBypassSession` (`packages/iam/src/auth.ts`) is checked at USE, in three places —
`tokens.ts` (mint), `auth/routes.ts` (`currentSession`) and `admin/router.ts`
(`resolveAdmin`) — so a bypass session stops working the moment `LOCAL_DEV_LOGIN` is
off rather than thirty days later.

An OIDC session after `OIDC_ENABLED=false` has the same shape and no such check. An
installation that moves to password-only keeps honouring every OIDC session for the
rest of its 30-day life, and an existing IAM session is exactly what makes a
cross-host handoff silent (ADR-0021). The same holds in reverse for password sessions
after `PASSWORD_ENABLED=false`, except that `disablePassword` revokes a specific
user's password sessions — the global switch does not.

Operator session revocation (shipped: `sessions.revoke` / `sessions.revokeAll`) gives
a human a way to clean this up. It does not make it automatic.

## Approach / acceptance

One predicate — `sessionUsable(session, config)` — replacing the three
`isDevBypassSession(...) && !localDevLogin` sites, refusing a session whose
`authentication_method` names a method the installation no longer enables.

⚠ **The trap, verified before filing:** `LOCAL_DEV_LOGIN` creates its session with no
`authenticationMethod`, which defaults to `'oidc'` (`auth/routes.ts:286`,
`SessionRepository.createSession`). The local Cloudflare config runs
`OIDC_ENABLED: 'false'` since wave 2 unified OIDC on fatal. So the naive rule
("refuse an oidc session when OIDC is off") disables the local dev bypass itself. The
bypass needs its own `authentication_method` value, or the predicate has to exempt it
explicitly — and giving it one is a `sessions` column change in both migration sets.

_Acceptance:_ a session created under a method the installation has since disabled is
refused at mint, at `currentSession`, and at `resolveAdmin`; `bun run local:up` still
signs in through `LOCAL_DEV_LOGIN`.

## Touch points

`packages/iam/src/auth.ts`, `tokens.ts`, `auth/routes.ts`, `admin/router.ts`,
`packages/iam/migrations*/` if the bypass gets its own method value.

<!-- Origin: sprint 2026-08-04 auth-hardening, WU-I. The item's own "generalisation worth considering" half; it did not fall out cheaply. -->
