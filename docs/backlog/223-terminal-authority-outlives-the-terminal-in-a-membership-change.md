---
id: 223
title: A terminal's authority outlives the terminal in a membership change
blocked-by: []
---

# 223: A terminal's authority outlives the terminal in a membership change

**Summary.** A membership change made on a terminal session can rest on grants only the terminal adds, and the grant it
writes stays after sign-out, release or revoke. Medium: it breaks ADR-0067's rule that a terminal's authority exists
only on that computer.

## Problem

A share link no longer has this gap: `issueLink` resolves the issuer's authority through `issuerAuthority`, which reads
only the person's own grants, and `resolveCredential` re-checks it at every mint.

The membership operations still check `caller.permissions`, which on a terminal session include the terminal
principal's grants (source `terminal`): `manageAuthority` and the role-action check in `roleAuthorityProblem`
(`packages/iam/src/membership.ts`). So `assignMember`, an invitation and `createScope` made with a terminal-added
`members.manage` or role action write a grant that outlives the terminal. `delegationDeadline` caps it at the expiry of
the terminal principal's grants, not at sign-out, release or revoke.

## Approach / acceptance

Leave `source: 'terminal'` entries out of the authority the membership operations check, as `issuerAuthority` does for
a link, or refuse them from a terminal token outright. If the exception is intended instead, state it in ADR-0067.
Tests: an `assignMember` from a terminal session whose only `members.manage` comes from the terminal is refused, and a
link issued from a terminal session whose only `issued_by` or grant comes from the terminal is refused (the link half
has no test yet).

## Touch points

`packages/iam/src/membership.ts`, `packages/iam/src/delegation.ts`,
`docs/decisions/0067-a-terminal-signs-a-person-in-on-an-application-s-word.md`.

<!-- Origin: the merge review of PR #32; narrowed by the merge review of PR #53. -->
