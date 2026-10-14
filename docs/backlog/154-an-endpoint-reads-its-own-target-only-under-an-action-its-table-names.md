---
id: 154
title: An endpoint reads its own target only under an action its table names
blocked-by: []
---

# 154 — An endpoint reads its own target only under an action its table names

**Summary.** The skill says "a capability reads its own target, whatever its action". The data layer reads it only
when the target's table names the action. An endpoint of a dimension's member action, or of an action a child table
names, cannot read the dimension row it acts on. Effort: S; it needs a decision first.

## Problem

- `ctx.db.target.get()` under `on: '<dimension>'` with an action its table does not name is a type error:
  `<table> does not name the action '<action>': read it from an endpoint whose action <table> names, or declare
  unscoped` (`packages/db/src/orm-types.ts:244`). The runtime reference states the rule precisely
  (`docs/reference/application-runtime.md:376`–`:379`); `packages/app/skill/references/endpoint.md:60` does not.
- An application built on the paved road loads a record's name and active flag in its member-management and submit
  endpoints. It moved the reads to `app` endpoints of a shared read action, read the row through `unscoped`, or used a
  composite foreign key to refuse a write against an inactive row (`23503` mapped to 403).

## Approach / acceptance

- Decide: a `Ref` of any action reads its own target row (not its subtree) with the columns no read action guards; or
  keep the rule and correct the skill's sentence.
- Witness: an `on` endpoint of the dimension's `members.manage` reads its target's unguarded columns, or the skill
  states the rule with this example.

## Touch points

`packages/db/src/{orm-types,orm,store}.ts`, `packages/app/skill/references/endpoint.md`,
`docs/reference/application-runtime.md`.
