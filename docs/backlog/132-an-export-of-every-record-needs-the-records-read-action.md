---
id: 132
title: An export of every record needs the records' read action
blocked-by: []
---

# 132 — An export of every record needs the records' read action

**Summary.** On the paved road an audited export of every record is an `app` mutation whose action is the records'
read action, so every global reader may export everything. A separate "may export" permission needs a declared
deviation. Effort: S–M; it needs a decision first.

## Problem

- `ctx.db.app` lists a dimension or child table only for its read action (`applicationTables`,
  `packages/db/src/orm.ts:405`–`:425`). `appGrant` and `checkAppReach` refuse any other action
  (`packages/db/src/store.ts:416`–`:434`, `:447`–`:462`), and since WU23c so does `ctx.sql.scope(ctx.app, table)`.
- The skill's export therefore declares `access: { action: 'candidates.read', app: true }`
  (`packages/app/skill/references/public-intake.md:781`–`:783`) and appends its log row with the same action
  (`:184`–`:187`, `:825`–`:828`). Every role that reads all candidates may also download all of them.
- An application that grants the export apart from reading (an HR lead may export, a reviewer may not) has two ways
  today, both off the road: an export of its own action with `unscoped: { <table>: 'read' }`, which the approver
  reviews as a deviation, or a second action checked in the handler, which the skill forbids
  (`packages/app/skill/SKILL.md:176`–`:177`). The private dogfood met
  this with its export of every record.

## Approach / acceptance

Decide one of these:

- **(a) A table names its export action.** A dimension or child table may declare an action that reads every row
  app-wide (`actions: { read, export }`), and `ctx.db.app` lists the table for it too, read-only. The approval diff
  shows the new action on the table, as any table action. No proxy change.
- **(b) An `app` endpoint names the read action it reads with** (`{ action: 'candidates.export', app: true, reads:
  'candidates.read' }`). The proxy requires both actions as global grants. It is the two-action requirement that
  [97](97-the-generated-tests-have-no-move-case.md)'s two-capability access also needs.
- **(c) Keep it.** The export's action is the read action; a separate permission is a declared `unscoped` read. The
  skill says so in the export recipe.

- Witness: the public intake recipe's export with an action of its own, no `unscoped` and no `sql`; a global holder of
  only `candidates.read` gets 403 on it; `classifyAccess` widens on the new action.

## Touch points

`packages/db/src/{policy,orm,orm-types,store}.ts`, `packages/auth-core/src/{contract,requirement}.ts` (only for (b)),
`packages/app/src/contract/`, `packages/control/src/approval/diff.ts`, `packages/app/skill/references/public-intake.md`,
`docs/decisions/0012-fabrika-app-runtime.md`.

<!-- Origin: the paved-road sprint, WU23a's decision (option (i)) and WU21 (the private dogfood). -->
