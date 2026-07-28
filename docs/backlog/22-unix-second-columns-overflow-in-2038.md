---
id: 22
title: Unix-second columns are int4 and overflow in 2038
blocked-by: []
---

# 22 — Unix-second columns are int4 and overflow in 2038

Every `*_at` column in the Postgres schemas is `INTEGER` (int4), holding unix
seconds. int4 caps at 2147483647 — **2038-01-19**.

## Why it is deliberate today

Bun's Postgres driver decodes `BIGINT` by column type OID and returns it as a
**string**, not a number. Every row shape in this repo types these columns as
`number`. Making them `BIGINT` today means every reader has to handle a string, so
the schemas use int4 everywhere it is safe and `BIGINT` only where int4 genuinely
cannot hold the value — the three millisecond columns (`deploy_locks.expires_at`,
`jobs.visible_at`, `jobs.created_at`), none of which any row shape reads.

`auth_log.id` is the one `BIGINT` a reader touches, and it is normalised at the
single read site with a test pinning `typeof === 'string'` so it cannot be silently
"fixed".

## What to do

Not urgent, but it needs deciding before it is urgent: either widen the columns and
teach the row shapes to normalise (the `auth_log.id` pattern generalises), or move
to a native timestamp type and change the row shapes wholesale. The second is
cleaner and larger.

## Acceptance

A written decision, and if widening: no reader typed `number` that can receive a
string.
