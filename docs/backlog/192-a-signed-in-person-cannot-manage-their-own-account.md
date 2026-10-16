---
id: 192
title: A signed-in person cannot manage their own account
blocked-by: []
---

# 192: A signed-in person cannot manage their own account

**Summary.** Give IAM an account page where a signed-in person changes their own password, sees and ends their own
sign-ins, and sees who they are signed in as; link it from the console's account menu. Needs ADR-0020 rewritten first.

## Problem

Everything a person can do about their own credentials today goes through someone else or through e-mail:

- **Password.** The only ways to set one are the single-use action flows (`/auth/password/enroll`,
  `/auth/password/reset`, `packages/iam/src/auth/password.ts:287-340`), reached from an administrator's issue or from
  `/auth/forgot-password` (`:199-236`), which needs an e-mail sender. A person who knows their password and wants a
  new one has to pretend they forgot it, and without mail cannot do even that.
- **Sign-ins.** Listing and revoking sessions exists only as administration (`sessions.list`, `sessions.revoke`,
  `sessions.revokeAll` in `packages/iam/src/admin/rpc.ts:70-80`, gated by `administrationOf` and
  `requireActableTarget`). A person who left a session open on another computer cannot end it.
- **No page.** IAM renders no page for a signed-in person outside a login handoff (`chooseAccountPage`,
  `packages/iam/src/password-pages.ts:74`) and the logout confirmation (`:159`). The console's account menu therefore
  holds only sign-out, the theme and builder connections (`packages/dashboard/src/routes/_layout.tsx`).

ADR-0020 decides that a person chooses a password only through the action flow ("the same short-lived, single-use
action flow in every installation"). A change with the current password is a second path that ADR does not allow, so
the decision comes first.

## Approach / acceptance

1. **Rewrite [ADR-0020](../decisions/0020-compose-human-authentication-methods.md) in place** to admit a
   self-service change: a person signed in on IAM with a password-origin session replaces their password by proving the
   current one. State what it does to other sessions (below), that it never enables a password for a principal without
   an enabled password account (the first invariant stands), and why re-proving the password is required although the
   session already authenticates the person.
2. **The page lives on IAM's host** (`/auth/account`), because the password and the `__Host-px_session` cookie are
   IAM's (ADR-0023); the console only links to it. It answers `currentLogin` (`packages/iam/src/auth/sessions.ts:49`)
   and sends anyone without one to sign-in with a same-origin `redirect` back. Server-rendered like the other pages
   (`htmlPage`, `password-pages.ts:296`), every POST behind `sameOrigin` (`packages/iam/src/auth/http.ts:30`),
   `form-action 'self'`, words from the catalog in both languages, the installation's locale.
3. **Change password.** Shown only when the password method is on and the principal's account is `enabled`
   (`passwords.getAccount`, `packages/iam/src/password-db.ts:93`); an OIDC-only person sees where their password
   lives instead. Current password verified with the login hasher; a wrong one counts in its own throttle bucket,
   keyed by principal, and never in the anonymous login buckets (`password.ts:19-39`). The new one passes
   `validatePassword` (`packages/iam/src/password-policy.ts:26`). The write follows the principal-lock rule and audits
   `iam.password.change` as the person (`selfEvent`, `password.ts:348`). `upsertCredential` revokes every password
   session, the caller's included (`password-db.ts:206-209`): the change keeps this browser signed in by issuing it a
   fresh session in the same batch, and ends the others.
4. **Your sign-ins.** The person's own IAM sessions (`app IS NULL`) from `listSessionsForPrincipal`
   (`packages/iam/src/repositories/sessions.ts:184`), active ones only, this browser marked, each with its method and
   when it started and ends. IAM stores no device or address (`SessionRow`, `:16-30`), so the list says only that.
   Ending one revokes it and, through the parent join, every app session made from it; "sign out everywhere else"
   keeps this one. Audited as `iam.session.revoke` / `iam.session.revoke_all` with the person as actor.
5. **The console** links "Account" from the account menu to IAM's `/auth/account`, the IAM origin read as for
   sign-out (`packages/dashboard/src/lib/session.ts`).

Witnesses, on SQLite and Postgres: a change with a wrong current password is refused and throttled after five tries;
a change ends the person's other password sessions and leaves an OIDC session alone (ADR-0020's invariant); the
changing browser stays signed in; a person cannot end another principal's session by id; a cross-site POST is
refused; an OIDC-only person is offered no password form. A browser suite: change the password, sign in with the new
one on a second browser, end the first browser's session from the second.

**Open.** Whether an external principal (ADR-0051) gets the same page; whether a session should record a coarse
device hint so the list can tell sign-ins apart (a privacy question, like
[172](172-a-list-of-values-cannot-show-each-values-last-sign-in.md)).

## Touch points

`docs/decisions/0020-compose-human-authentication-methods.md`, `packages/iam/src/auth/` (`routes.ts`, a new
`account.ts`, `password.ts`, `sessions.ts`), `packages/iam/src/password-pages.ts`, `packages/iam/src/password-db.ts`,
`packages/iam/src/repositories/sessions.ts`, `packages/iam/src/catalog/{index,en,cs}.ts`,
`packages/dashboard/src/routes/_layout.tsx`, `packages/dashboard/src/lib/session.ts`,
`docs/reference/human-authentication.md`, `tests/browser/`.
