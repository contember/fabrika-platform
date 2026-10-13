---
id: 138
title: The external onboarding flows have no browser run
blocked-by: []
---

# 138 — The external onboarding flows have no browser run

**Summary.** The external-people sprint proved its flows with IAM route tests on both backends, never in a browser
through the proxy. A browser suite now covers password sign-in from Notes in `cs` and an administrator's enrollment and
reset; everything that needs an e-mail is still unrun. Effort: M.

## Problem

`tests/browser/notes-password-sign-in-and-reset.test.ts` runs the set-password page and the password sign-in from Notes
(in `cs`) back into Notes, with links an administrator receives by manual delivery. Nothing in `tests/browser` runs
the rest, and the local composition cannot drive it:

- **No e-mail sender.** The composition runs IAM with `FABRIKA_EMAIL_PROVIDER: none`, and `resend` is the only other
  sender, with a fixed API origin. Without a sender the sign-in page offers no forgot-password
  (`auth/password.ts`, `forgotEnabled`), a forgot-password request sends nothing, and every e-mail assignment is
  `invitations_disabled` (`membership.ts`). Manual delivery covers only an administrator's enrollment and reset, and
  an administrator's action is app-less, so it lands on IAM's origin rather than in the application.
- **No application with an external role.** Notes declares no membership dimension, no external role and no staff
  role that may assign one, and no endpoint that calls `ctx.members.assign`.

Still unrun in a browser: forgot-password from the application in `cs` landing back in it; a new mailbox invited by a
staff member sets its password and lands in the application as an external principal; the same person invited by a
second company signs in and accepts; a browser signed in as someone else is refused the creating form. The CSP
`form-action` widening on the set-password and invitation pages by the application's landing origin
(`packages/iam/CLAUDE.md`) is the kind of rule only a real browser checks, and only an action that keeps an
application exercises it.

## Approach / acceptance

Decide how the composition captures IAM's mail: a composition seam for IAM's `EmailSender` (as Control's
`sourceSeams` are for GitHub, ADR-0029) with a local sink the suite reads, or another mechanism the owner picks. Give
an example application an external membership role, a staff role that may assign it, and an endpoint that invites.
Then add the four flows above to `tests/browser`, each green twice from a reset stack.

<!-- Origin: the external-people sprint, WU3 and WU5. -->
