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
   links carry on and the proxy's sign-in bounce writes (item 5); the host-only `__Host-fabrika_locale` cookie a
   sign-in, or an invitation's "sign in first", leaves on IAM's host; the application's `locale`; the browser's
   `Accept-Language`; the default. An e-mail has no request: the person's, else the application's, else the
   default; a forgot-password e-mail to a person without a language of their own takes the language of the page that
   asked for it, so an application without a `locale` sends it in the browser's language.
2. **The application's language ranks above the browser's.** An application that declares a `locale` and names none
   on an invitation shows exactly the pages and e-mails it showed before.
3. **Every source picks words only.** None decides a landing, an origin or an authority. `principals.locale` is written
   alone, outside any principal's lock order and without an audit record; a failed write (or, after a sign-in, a failed
   read) is logged and never fails an acceptance or a sign-in.
4. **No application reads it back.** No RPC result or member listing carries it, and the forgot-password answer does
   not depend on it.
5. **The sign-in an application's proxy starts carries the application's word for the browser.** An application may
   write `__Host-fabrika_locale` on its own host (the name and `LOCALE_PARAM` are `@fabrika/auth-core`'s; an SPA calls
   `rememberSignInLocale` of `@fabrika/app/client`); the proxy adds its value, when it is a language IAM speaks, to
   the login URL as `?locale=`. The proxy decides exactly as without it: the status, the reason, the return URL and
   the handoff are unchanged, and the cookie is not a credential (it does not start with `__Host-px_`, so it reaches
   the application). One rule in `@fabrika/proxy-core` serves the Cloudflare proxy Worker and the Zerops proxy alike.
6. **An invitation's "sign in first" remembers the person's language.** It sends the browser to the application's
   address, whose proxy starts a sign-in that IAM's `?locale=` cannot reach, so the answer sets
   `__Host-fabrika_locale` on IAM's host to the invitation's language (else the link's). An application's own language
   cookie, passed by its proxy as `?locale=`, still outranks it on that sign-in. The sign-in that follows
   replaces or clears it as any sign-in does; the invitation link the person then opens again carries the
   invitation's language itself.

## Consequences

- A person invited in Ukrainian by one application reads IAM in Ukrainian for every application on the installation,
  including one that declares Czech. The most recently accepted invitation that names a language replaces the stored
  one, so applications that name different languages for the same person take turns.
- An application without a `locale`, and IAM's own pages, now follow the browser instead of always the default.
- The sign-in an application's proxy starts carries `?locale=` only when the application left a language on its own
  host. A visitor the application has not seen yet, on a browser where they have not signed in and with no invitation
  in hand, still reads the application's language, else the browser's. An application that serves people of several
  languages and wants the browser to decide that first page declares no `locale`; several declared languages are an
  open alternative (below).
- A client can write either cookie. It picks words only, so the most it changes is the language of a page the same
  browser reads.
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
- **The proxy forwards a language from the application's URL.** An invitation's link to the application could carry
  `?locale=` for the proxy to pass on, but the query belongs to the application, and the proxy would start reading
  one of its parameters. A cookie the application writes on purpose is an explicit contract, and IAM's own cookie
  covers the invitation, which never passes through the application before the sign-in.
- **An application declares several languages** (`locales: ['cs', 'uk']`) and the browser picks among them. Not
  chosen now, and not rejected. It is the only source that helps the first visit of a visitor nobody knows yet, on a
  fresh browser with no invitation, and it would keep an application's main language for a browser asking for one the
  application does not serve, which declaring no `locale` gives up (such a browser reads IAM's default). It widens the
  contract, the schema reconcile and IAM's storage (a migration in both dialects), so it waits for an application
  that needs it; it would add a source beside the application's `locale` and change none of items 1 to 6.
- **The application's language always wins.** No cross-application effect, but a person in a Czech application who
  reads Ukrainian could never get IAM's pages in Ukrainian, which is the case this decision exists for.
