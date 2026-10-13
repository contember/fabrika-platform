---
id: 137
title: The CRM reference and the skill disagree on three conventions
blocked-by: []
---

# 137 — The CRM reference and the skill disagree on three conventions

**Summary.** The second fresh-agent trial found three places where an agent that follows the skill writes something
other than `examples/crm`, so `classifyAccess` against the reference reports the skill's own choice as a widening.
Effort: S.

## Problem

- **The pipeline.** The skill's "nearest dimension" rule gives `over: 'company'` with `aggregate`; both group-B agents
  wrote that. The reference uses `over: 'org'` with `sql: 'read'`, a declared deviation the paved road does not need.
- **"The caller owns it".** The reference stores the principal's label for a deal's owner and asks the directory for a
  task's default assignee. The skill names neither as the rule.
- **Inputs and schemas.** The skill does not say whether an omitted input is optional or nullable, or whether a slice's
  schemas live in the slice or in `src/schemas.ts`; each "became optional" reads as a widening.

## Approach / acceptance

Move the reference pipeline onto `aggregate` over `company`, pick one rule for the caller's own name and one for
optional inputs and schema placement, and write them in the skill. Witness: `classifyAccess` of a round-2 group-B
trial against the new reference shows no widening for the pipeline.

<!-- Origin: the paved-road sprint, the fresh-agent trial round 2 (judge report). -->
