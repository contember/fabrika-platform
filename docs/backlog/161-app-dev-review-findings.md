---
id: 161
title: The kit's share links never expire, and an app dev seed error can print a record key
blocked-by: []
---

# 161 — The kit's share links never expire, and an app dev seed error can print a record key

**Summary.** Two findings of the review of `fabrika app dev` (batch L), recorded instead of fixed under the
go-with-nits bar. Effort: S.

## Problem

- **A kit share link never expires.** The stand-in IAM mints a token for a share-link key it issued
  (`packages/app/src/testing/membership.ts:658`) without checking the link's `days`. A one-day link still opens after
  its deadline, so a test or a preview cannot show an expired link the way IAM answers it.
- **A seed validation error can print a mailbox.** `app-dev-seed.ts:87` reports an invalid seed answer through Zod's
  error path. A `scopes` record keyed by a value such as a mailbox prints that key.

## Approach / acceptance

- Store `expiresAt` when the stand-in issues a link and refuse a token for it afterwards, as IAM does. Witness: a
  one-day link refused after the kit's clock moves past it.
- Redact record keys (and any value) from seed validation messages: name the entry's position and the field only.
  Witness: an invalid `scopes` record keyed by a mailbox prints no mailbox.

## Touch points

`packages/app/src/testing/membership.ts`, `packages/cli/src/app-dev-seed.ts`.
