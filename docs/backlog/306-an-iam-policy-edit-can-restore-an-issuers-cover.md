---
id: 306
title: A machine's edit of an IAM-level policy can restore what an issuer's keys hold
blocked-by: []
---

# 306 — A machine's edit of an IAM-level policy can restore what an issuer's keys hold

**Summary.** A key issued for someone else holds what its issuer covers (`delegation.ts`). A machine caller holding
`iam.admin` can still widen that cover back by editing a policy at IAM's own audience. Such an edit is installation
administration (ADR-0083 §9), which the `credentials` gate does not judge. Low severity, about half an agent day.

## Problem

- **The scenario.**
  - Issuer I holds role R at IAM, without `iam.admin`, so a key K that I issued holds only what I holds at K's
    application.
  - A machine caller then adds `iam.admin` to R with `policies.update`, or with a schema reconcile at IAM's own app.
  - K now holds its whole set again, at an environment whose `credentials` mode is `person`.
- **What is already gated.** A grant of `iam.admin` to I and re-enabling I are both judged by the reach of I's issued
  keys (`issuedKeysReach` in `packages/iam/src/credentials-gate.ts`). A policy edit at IAM is not: judging it needs every
  holder of the role, and then each holder's issued keys.
- Found by the fixes for the review of PR #442.

## Approach / acceptance

- When a machine caller changes a role or policy at IAM's audience so that it gives `iam.admin`, judge the issued keys
  of every principal holding that role, with the same rule as a grant.
- Alternatively, state in ADR-0083 §9 that an IAM-level policy edit by a key holding `iam.admin` is trusted because a
  person gave that key `iam.admin`.
- Either way, a test shows the chosen behaviour for the scenario above.
- If the judging route is chosen, add an index on `credentials.issued_by`: the issued-keys lookup scans the table today.

## Touch points

- `packages/iam/src/admin/policies.ts`
- `packages/iam/src/admin/app-schema.ts`
- `packages/iam/src/credentials-gate.ts`
- IAM migrations, if an index is added
- ADR-0083 §9

<!-- Origin: the review of PR #442 (step 8 of ../ideas/agent-requested-approvals.md). -->
