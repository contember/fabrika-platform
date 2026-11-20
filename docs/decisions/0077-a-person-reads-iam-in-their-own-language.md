---
id: 0077
title: A person reads IAM in their own language, on the whole installation
status: proposed
date: 2026-11-20
---

# 0077 — A person reads IAM in their own language, on the whole installation

## Context

IAM's sign-in, password and invitation pages and its e-mails speak one language per application: the contract's
`locale`, else the installation's default. An application whose people speak several languages could pick only one
for all of them, and IAM's own pages (sign-out, terminal enrolment, a refusal before any application is known) always
spoke the default.

A principal is the installation's, not an application's: one sign-in at IAM spares the next handoff to any application
the person is a member of. Only an application knows which language a person reads;
IAM learns it when the application invites them. Before IAM knows who is reading (a sign-in page, an invitation page
before its form is posted), it has only the request.

## Decision

**We will keep a person's language on the principal (`principals.locale`), set from the language an application names
on an invitation (`InvitationOptions.locale`) when the person accepts it, and speak it on IAM's pages and e-mails for
every application.**

1. **The person's language beats the application's.** A page takes the first language IAM speaks from: the person's
   own as stored for the flow (invitation, password action, principal); a link's or form's `?locale=`, which IAM's own
   links carry on; the host-only `__Host-fabrika_locale` cookie a sign-in leaves; the application's `locale`; the
   browser's `Accept-Language`; the default. An e-mail has no request: the person's, else the application's, else the
   default; a forgot-password e-mail to a person without a language of their own takes the language of the page that
   asked for it, so an application without a `locale` sends it in the browser's language.
2. **The application's language ranks above the browser's.** An application that declares a `locale` and names none
   on an invitation shows exactly the pages and e-mails it showed before.
3. **Every source picks words only.** None decides a landing, an origin or an authority. `principals.locale` is written
   alone, outside any principal's lock order and without an audit record; a failed write (or, after a sign-in, a failed
   read) is logged and never fails an acceptance or a sign-in.
4. **No application reads it back.** No RPC result or member listing carries it, and the forgot-password answer does
   not depend on it.

## Consequences

- A person invited in Ukrainian by one application reads IAM in Ukrainian for every application on the installation,
  including one that declares Czech. The most recently accepted invitation that names a language replaces the stored
  one, so applications that name different languages for the same person take turns.
- An application without a `locale`, and IAM's own pages, now follow the browser instead of always the default.
- The sign-in an application's proxy starts carries no `?locale=`; on a browser where the person has not signed in yet
  it follows the remembered, the application's or the browser's language.
- There is no way to change a person's language outside an invitation. Adding one (a person's own setting, an
  administrator's) writes the same column.
- Migration `0031_person_locale` adds three nullable columns (`membership_invitations`, `principals`,
  `password_action_tokens`); NULL keeps today's behaviour, so an existing installation converges on upgrade without a
  backfill.

## Alternatives considered

- **A language per membership** (the application's own record of the person). Each application would keep its
  person's language, but IAM's pages before an application is known, and the session shared across applications,
  would have no single answer, and every page would need the membership to choose words.
- **The browser above the application.** Simpler, but an application that declares a language would change its pages
  for every visitor whose browser asks for another one, which breaks the promise that a declared `locale` shows the
  same pages.
- **The application's language always wins.** No cross-application effect, but a person in a Czech application who
  reads Ukrainian could never get IAM's pages in Ukrainian, which is the case this decision exists for.
