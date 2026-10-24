---
id: 225
title: Smaller gaps of the installation's minimum password length
blocked-by: []
---

# 225: Smaller gaps of the installation's minimum password length

**Summary.** Low-severity gaps the merge review of the minimum password length (ADR-0020) left open.

## Problem

- **The audit does not show a lowering.** `iam.password_policy.update` records only the new `minLength`
  (`packages/iam/src/admin/password-policy.ts`), so the audit log alone cannot tell a lowered minimum from a raised one.
- **A minimum of 256 stops enrolment.** The contract admits a minimum up to the maximum
  (`packages/iam-contract/src/password-policy.ts`), so every new password would have to be exactly 256 code points.
  It is self-inflicted and an administrator can undo it.
- **The console page is briefly stale after a save.** Settings → Passwords (`packages/dashboard/src/routes/settings/passwords.tsx`)
  compares against `current` until `invalidate()` reloads it, so "Save minimum" is enabled again for a moment. The
  branding page behaves the same way.

## Approach / acceptance

- Put the previous minimum in the audit metadata.
- Cap the minimum well below the maximum (for example 64), or warn in the console.
- Compare against the saved value once the save succeeds, here and on the branding page.

## Touch points

`packages/iam/src/admin/password-policy.ts`, `packages/iam-contract/src/password-policy.ts`,
`packages/dashboard/src/routes/settings/`.

<!-- Origin: the review of PR #47. -->
