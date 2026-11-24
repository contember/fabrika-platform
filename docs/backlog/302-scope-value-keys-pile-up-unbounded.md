---
id: 302
title: Scope-value keys pile up and are not rate limited
blocked-by: []
---

# 302 — Scope-value keys pile up and are not rate limited

**Summary.** Each grant form that opens a dimension with a value source writes one 60-second `credentials` row, and
nothing prunes expired keys or bounds how often an administrator asks. Low severity; found in the security review of
ADR-0085 §4.

## Problem

`scopeValues.list` (`packages/iam/src/admin/scope-values.ts`) issues a self-bound key per call. The row stays after it
expires, as every expired key's does, and IAM's prune (`src/cron.ts`) does not remove expired credentials. A signed-in
administrator can call the procedure in a loop: each call writes a key, an audit row, and one request to the
application. The caller is an authenticated administrator and every call is audited, so this is growth and load, not
an escalation.

## Approach / acceptance

- The retention prune deletes credential rows expired longer than a bound (all kinds, or the scope-value keys first);
  `cron.test.ts` counts them.
- A per-administrator bucket bounds `scopeValues.list` (for example 60 per minute), answering `unavailable` past it;
  a test shows the refusal writes no key.

## Touch points

`packages/iam/src/cron.ts`, `packages/iam/src/admin/scope-values.ts`, the login throttle table or a bucket of its own,
both migration sets if a new table is needed.

<!-- Origin: the security review round of the live scope values change (ADR-0085 §4), finding P3. -->
