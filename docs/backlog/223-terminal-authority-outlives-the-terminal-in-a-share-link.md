---
id: 223
title: A terminal's authority outlives the terminal in a share link
blocked-by: []
---

# 223: A terminal's authority outlives the terminal in a share link

**Summary.** A share link issued from a terminal session can carry grants only the terminal adds, and the link stays
valid after sign-out, release or revoke. Medium: it breaks ADR-0067's rule that a terminal's authority exists only on
that computer.

## Problem

`issueLink` (`packages/iam/src/membership.ts`) checks the issuer's authority against `caller.permissions`. On a terminal
session these include the terminal principal's grants (source `terminal`). The link credential freezes its grants, and
`packages/iam/src/tokens.ts` serves them without looking at who issued the link again. So a person at a terminal, or an
asserting application naming a colleague, can turn the terminal's added authority into a credential that works anywhere
for up to the mount's `max_days`. Membership changes such as `assignMember` made with a terminal-added `members.manage`
outlive the terminal the same way, though they only reach what the delegation rules allow anyway.

## Approach / acceptance

Leave `source: 'terminal'` entries out of the issuer's authority in `issueLink` and the other delegation operations, or
refuse them from a terminal token outright. If the exception is intended instead, state it in ADR-0067. A test issues a
link from a terminal session whose only `issued_by` or grant comes from the terminal, and is refused.

## Touch points

`packages/iam/src/membership.ts`, `docs/decisions/0067-a-terminal-signs-a-person-in-on-an-application-s-word.md`.

<!-- Origin: the merge review of PR #32. -->
