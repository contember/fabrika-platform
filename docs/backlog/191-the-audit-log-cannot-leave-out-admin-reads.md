---
id: 191
title: The audit log cannot leave out admin reads
blocked-by: []
---

# 191: The audit log cannot leave out admin reads

**Summary.** Let IAM's `audit.list` leave out the admin reads (`iam.admin.access`), so a feed of what changed gets
changes from IAM instead of paging past reads in the browser. Small; a contract addition.

## Problem

IAM audits every read of its admin API as `iam.admin.access` (`packages/iam/src/admin/access.ts:7`), the console's own
reads included. Reads far outnumber changes, so the console's two feeds of recent changes (the overview's activity and
the Access overview) fetch pages of 200 rows and drop the reads in the browser, up to three pages one after another
(`recentAuditChanges`, `packages/dashboard/src/lib/iam.ts`). That costs:

- up to three round trips in a row before either page can render;
- another audited read per page fetched, which pushes the real changes further back for the next load;
- a feed that can come back empty on a busy installation, when 600 rows are all reads.

`ListAuditInput` (`packages/iam-contract/src/index.ts:454`) can only match one action exactly, so the console cannot
ask for "everything but reads".

## Approach / acceptance

- `ListAuditInput` gains a way to leave actions out, either `excludeActions: string[]` or a narrower
  `changesOnly: boolean` that leaves out `iam.admin.access`. The repository adds the matching `action NOT IN (...)` to
  its query (`listAuditEvents`, `packages/iam/src/repositories/audit.ts:260`), keeping the keyset cursor as it is.
- `recentAuditChanges` asks for changes only and reads one page; `AUDIT_READ_ACTIONS` and the paging go away.
- An IAM test that the filter leaves reads out and pages correctly across them; the dashboard's IAM tests updated to
  one call.

## Touch points

`packages/iam-contract/src/index.ts`, `packages/iam/src/admin/audit.ts`, `packages/iam/src/repositories/audit.ts`,
`packages/dashboard/src/lib/iam.ts`, `packages/dashboard/src/__tests__/iam.test.ts`.
