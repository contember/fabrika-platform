---
id: 289
title: Caller rows reach only the global case, and a caller's id is no principal id
blocked-by: []
---

# 289 — Caller rows reach only the global case, and a caller's id is no principal id

**Summary.** The endpoint access kit seeds `callerRows` (the caller's own record, such as a person's card bound to
the account) only for the caller of a `global` case. In an application whose handlers refuse a caller without one,
this leaves the other cases weaker or unsatisfiable. A record keyed by the principal id, or with a `uuid` principal
column, cannot be seeded. Effort: S.

## Problem

- **Negative cases pass for the handler's reason.** `scoped`, a `denied` case that expects 403, and `capability` ask
  as a caller without the record. If the proxy wrongly admitted that caller, the handler would still answer 403 for
  the missing record, so the case would not see the proxy's mistake.
- **Positive cases cannot pass.** `own` and `leaked` expect an answer. In such an application they fail, and `appRows`
  cannot name the caller.
- **The key cannot be the principal id.** `applicationRowsPlan` refuses a value for a row's key (it is stamped), so
  `{ profiles: { id: 'fabrika:caller' } }` is a finding. `seedApplicationRow` already accepts a supplied key.
- **The id is not shaped like a principal id.** The kit's callers are `human-N` and `machine-N`, while IAM issues
  UUIDv7. A `uuid` principal column fails at seeding on Postgres, and the checker, which has no column types, cannot
  warn ahead. Two kits in one file also restart at `human-1`, which is safe only because their cases run one after
  another.
- **Smaller gaps.**
  - An application with no tested `app` or `creates` endpoint gets no finding for `callerRows` that never apply.
  - `'fabrika:caller'` in `appRows` or `seeds` is written as a literal.
  - A `creates` handler that inserts the caller's own record ("claim my card") meets the seeded one, and its global
    case fails on the unique index; there is no per-endpoint opt-out.

## Approach / acceptance

- Seed `callerRows` for every caller the kit makes, with `callerFor` and `ask` both returning their caller. Values
  the author gives carry no marker, so they never count as leaked.
- Issue each kit caller a UUID id (`testCaller(grants, { id: crypto.randomUUID() })`). Check this against the kit's
  other uses of the id.
- Let `GENERATED_CALLER` set a row's key in `applicationRowsPlan`.
- Add a finding for `callerRows` without a global case, and for `'fabrika:caller'` outside `callerRows`.
- Acceptance: in a fixture application whose handlers refuse a caller without a card, every generated case passes
  with one `callerRows` entry. A proxy that wrongly admits a one-scope holder fails its `scoped` case.
