---
id: 138
title: The external onboarding flows have no browser run
blocked-by: []
---

# 138 — The external onboarding flows have no browser run

**Summary.** The external-people sprint proved its flows with IAM route tests on both backends, never in a browser
through the proxy. Effort: S.

## Problem

Nothing in `tests/browser` signs in from an application in `cs`, resets a password and lands back in the application,
or accepts an invitation that creates an external principal and hands the browser off to the application. The CSP
`form-action` widening on the set-password and invitation pages (`packages/iam/CLAUDE.md`) is the kind of rule only a
real browser checks.

## Approach / acceptance

An opice suite against the local stack: sign-in → forgot → reset → back in the application, in `cs`; a new mailbox
invited by a staff member sets its password and lands in the application; the same person invited by a second company
signs in and accepts; a browser signed in as someone else is refused the creating form.

<!-- Origin: the external-people sprint, WU3 and WU5. -->
