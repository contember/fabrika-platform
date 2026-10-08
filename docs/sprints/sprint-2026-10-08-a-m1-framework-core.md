# Sprint — A-M1: framework core (2026-10-08)

**Goal.** Applications written against the contract on both clouds, with generated gates, in-process checks and a
checker: A0–A7 of the [implementation plan](../ideas/app-framework-implementation-plan.md).

**Theme.** Part A's foundation. Run by the [orchestration](../ideas/app-framework-orchestration.md).

## Refs re-verified at HEAD (2026-10-08)

Each work unit re-verifies the plan's facts it depends on before coding.

## Work units

The work units are A0–A7 in the plan; their text is not copied here.

| WU | State             | Commits / note         |
| -- | ----------------- | ---------------------- |
| A0 | landed            | `b74a4354`, `3373f2a7` |
| A1 | in review fixes   |                        |
| A2 | queued (after A1) |                        |
| A3 | queued (after A2) |                        |
| A4 | queued (after A3) |                        |
| A5 | queued (after A3) |                        |
| A6 | queued (after A3) |                        |
| A7 | landed            | `f93d8ba8`…`57faff7a`  |

## Out of scope (explicit)

A-M2 and later; part B.

## Decisions

- H2: A0 text approved by the owner. `ContractArtifact` types live in `auth-core`; its zod schema lives where it is
  parsed. zod is a peer dependency of `@fabrika/app`. ADR-0022's "no issuing method" is reworded in A13.
- H4: the parser is `@babel/parser` 8.0.7 (`typescript` + `estree`).
- A7: `@fabrika/check` exposes the `fabrika-check` bin; directly spelled forms are refused, aliased forms are
  accepted D11 escapes with escape fixtures; the supported `z` subset is listed in `packages/check/CLAUDE.md`.

## Sequencing

A1 → A2 → A3 → {A4, A5, A6}; A7 independent.

## Run log

- 2026-10-08: A7 landed after one fix round covering 25 review findings.
