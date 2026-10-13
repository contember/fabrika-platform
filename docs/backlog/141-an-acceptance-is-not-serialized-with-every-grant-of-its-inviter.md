---
id: 141
title: An acceptance is not serialized with every grant of its inviter
blocked-by: []
---

# 141 — An acceptance is not serialized with every grant of its inviter

**Summary.** An invitation's acceptance writes only while the inviter is enabled, holds its assigning grant and the
schema is at the checked revision. An administrator deleting ANOTHER grant of the inviter's, one that supplied an
action of the invited role, between the check and the write is not seen. Effort: M.

## Problem

`checkedAuthority` (`packages/iam/src/repositories/membership.ts`) locks the inviter's principal row, the schema
revision, the assigning grant and the role row. The action ceiling is checked against the inviter's live permissions
before the batch, from grants it does not lock. Today's signed-in acceptance had the same property before WU5.

## Approach / acceptance

Serialize grant writes per principal (every grant write takes the principal row first, as the password writers do),
or re-evaluate the ceiling inside the batch. Witness: a two-connection Postgres test where the supplementing grant is
deleted between the check and the write, and the acceptance writes nothing.

<!-- Origin: the external-people sprint, WU5's review. -->
