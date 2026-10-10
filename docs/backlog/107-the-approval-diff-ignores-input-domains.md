---
id: 107
title: The approval diff ignores input domains
blocked-by: []
---

# 107 — The approval diff ignores input domains

**Summary.** Widening what an endpoint accepts (a literal becomes an enum, a maximum is removed) classifies as
`unchanged`, so it publishes on a protected environment without a human. A defect against ADR-0050's decision that
every widening waits. Small effort.

## Problem

ADR-0050 decides that every widening on a protected environment waits for a human, and that whatever cannot be shown
to narrow is treated as widening. Its §3 list of compared data names endpoint callers, access forms and output fields,
but not input:

- `endpointChanges` (`packages/control/src/approval/diff.ts:170–179`) compares kind, route, callers, requirement,
  admission and output; `procedure.input` is never read.
- The table policy limits which columns a handler may write, not which values. When `update` already lists `stage`,
  changing a mutation's input from `stage: z.literal('lead')` to `z.enum(['lead', 'won'])` lets callers write states
  they could not before, with no table, role, migration or output change.

Reproduced on `main` (4f02fcd8) through `readContractSource` and `classifyAccess`: that edit, and removing
`.max(200)` from a `title` input, each classify as `{ outcome: 'unchanged', changes: [] }`. The contract digest
changes; the endpoint digest (`packages/auth-core/src/endpoint-digest.ts`, which excludes schemas by design) does not.

## Approach / acceptance

- Compare input shapes conservatively in `endpointChanges`: a removed optional field or an exactly equal shape is not a
  widening; any other change is, with a line that names the field ("Endpoint `api.deals.move` input `stage` admits
  `won`"). No logical implication between schemas.
- Descend into arrays and nullable objects for both input and output, so a line names the nested field.
- Add input to ADR-0050 §3's list in the same change.
- Witness: `approval-diff.test.ts` cases for a literal widened to an enum, an enum gaining a value, a removed or raised
  `max`/`min`, a new optional field (widening), a removed field (removal) and an unchanged shape (unchanged).

## Touch points

`packages/control/src/approval/diff.ts`, `packages/control/src/__tests__/approval-diff.test.ts`,
`docs/decisions/0050-approved-access.md`.

<!-- Origin: the security critique of docs/ideas/agent-friendly-app-framework.md. -->
