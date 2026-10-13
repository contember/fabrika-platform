---
id: 140
title: The test kit's stand-in IAM does not model every membership answer
blocked-by: []
---

# 140 — The test kit's stand-in IAM does not model every membership answer

**Summary.** `kitMembership` (`packages/app/src/testing/membership.ts`) refuses what IAM refuses for scopes, members
and links, but three answers of IAM are not modelled, so an application's own test of them needs a real IAM. Effort: S.

## Problem

- A repeated assign answers the same open invitation in IAM; `resend: true` rotates it; an external role assigned to an
  organization mailbox answers `internal_mailbox`. The stand-in models none of them.
- An `on` endpoint that cancels an invitation or revokes a link by its id fails its generated cases: the stand-in
  knows only the invitations and links a case made, and answers any other id 404 (`packages/app/skill/SKILL.md`, "Not
  built yet").

## Approach / acceptance

Model the three answers; let the generated case of a cancel or revoke endpoint seed the invitation or link it names.
Witness: the isolation fixture gains a cancel endpoint and its generated cases pass; the "Not built yet" line goes.

<!-- Origin: the external-people sprint, backlog 113 and WU5. -->
