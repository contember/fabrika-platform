---
id: 227
title: Smaller gaps of the authorization model's platform fixes
blocked-by: []
---

# 227: Smaller gaps of the authorization model's platform fixes

**Summary.** Low-severity gaps the merge review of the authorization model's platform fixes left open.

## Problem

- **A workload's token gets the larger bound.** The docs say a workload's token keeps 8 KiB, but `mintFromKey`
  (`packages/iam/src/tokens.ts`, `proxyMintedBound`) gives every key at a contract application, workload keys included,
  the 24 KiB bound. Harmless today, since workload tokens are small.
- **The app CLAUDE.md states the old bound.** `packages/app/CLAUDE.md` still says the kit answers 403 above
  `MAX_ACCESS_TOKEN_BYTES`; the kit now uses the application token's 24 KiB bound for a person.
- **A terminal session's token can end early.** Its expiry is capped by the person's ceiling-narrowed entries even when
  the terminal grants the same action without an expiry (`packages/iam/src/tokens.ts`). Safe, but it re-mints sooner.
- **A duplicate import.** `packages/provider-zerops/src/execution.ts` imports `@fabrika/auth-core` twice.

## Approach / acceptance

- Exclude workload keys in `proxyMintedBound`, or drop the 8 KiB claim from the docs.
- Correct the line in `packages/app/CLAUDE.md`.
- Cap a terminal session's expiry by the entry that actually carries each action, if the early re-mint shows up.
- Merge the two imports.

## Touch points

`packages/iam/src/tokens.ts`, `packages/iam/CLAUDE.md`, `packages/app/CLAUDE.md`, `packages/provider-zerops/src/execution.ts`.

<!-- Origin: the merge review of PR #53. -->
