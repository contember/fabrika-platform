---
id: 158
title: No document says who enforces each guarantee
blocked-by: []
---

# 158 — No document says who enforces each guarantee

**Summary.** An application author cannot tell which promise of the paved road is enforced by the types, which by
the checker, which by the runtime, and which only by the human review of a declared exception. Effort: S–M (docs).

## Problem

- The same rule is enforced at different layers: a scope fragment's statement use only at run time, a form's field
  names at boot, a table's actions by the types. An application built on the paved road met several of these first as a failing
  generated case.
- The declared exceptions (`sql`, `unscoped`, link `issues`, anonymous mounts) are guarantees only through the
  approver's review. Their reach is coarse: `sql: 'read' | 'write'` names no table.
- `docs/reference/overview.md` defines enforcement, authorization and admission; nothing lists the application-level
  guarantees and their enforcers.

## Approach / acceptance

- A reference section (`docs/reference/application-runtime.md`, mirrored briefly in the skill) with one row per
  guarantee: what it promises, where it is enforced (types, checker, boot, runtime, review), and the declaration that
  lifts it.
- Witness: each row cites the enforcing code or the approval-diff line, and the skill links the table from its
  deviations section.

## Touch points

`docs/reference/application-runtime.md`, `packages/app/skill/SKILL.md`, `packages/app/skill/references/errors.md`.
