---
id: 169
title: App dev runs no cron job, and the stand-in IAM lists no invitation
blocked-by: []
---

# 169 — `fabrika app dev` runs no cron job, and the stand-in IAM lists no invitation

**Summary.** Two places where `app dev` and the test kit answer differently from production, so a person clicking
through a preview sees a state production never shows. Effort: S–M.

## Problem

- **No cron job runs on its schedule.** `app dev` runs a job only when the seed calls `dev.runJob`, or when a form's
  or a mutation's `then` kicks it (`packages/app/skill/references/dev.md:54`, `:98`); `packages/cli/src/app-dev.ts`
  has no scheduler. A job nothing kicks (a nightly sweep) never runs from the browser, and a row a kicked run left
  behind (a send that failed and waits for its `next_attempt_at`) stays queued: the page says the e-mail is on its
  way, and the mail view never shows it.
- **The stand-in IAM's `listMembers` answers `invitations: []`**
  (`packages/app/src/testing/membership.ts:294`), though the kit keeps every invitation it opened
  (`membership.ts:442`) and IAM answers the open invitations of the value to a `members.manage` holder
  (`packages/auth-core/src/membership.ts:260`, `:290`). A screen that lists a value's people with their open invitations shows
  none under `app dev` or a plain `testKit`.

## Approach / acceptance

- Run each cron job on its schedule while `app dev` serves, through the same path as `dev.runJob`, with
  `parseCron`/`previousDue` of `packages/app/src/jobs/schedule.ts`. A "run now" control in the dev toolbar is the
  smaller alternative; pick one, not both, unless a run on schedule turns out to be noisy. Witness: an `app-dev.test.ts`
  case whose fixture has a per-minute job sees it run with no seed call (a clock the test controls, not a real
  minute).
- `listMembers` answers the value's open invitations (not accepted, not cancelled, not expired) to a caller that
  manages the value's members, as IAM does. Witness: a kit test invites an address, then lists the value and finds
  the invitation; after `acceptInvitation` it is gone.

## Touch points

`packages/cli/src/{app-dev.ts,app-dev-ui.ts}`, `packages/cli/src/__tests__/app-dev.test.ts`,
`packages/app/src/testing/membership.ts`, `packages/app/src/__tests__/`, `packages/app/skill/references/dev.md`.

<!-- Origin: framework gaps an application built on the paved road met on the 0.4.1 React stack. -->
