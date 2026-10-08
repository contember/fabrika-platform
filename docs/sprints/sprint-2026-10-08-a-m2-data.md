# Sprint — A-M2: the scoped data layer (2026-10-08)

**Goal.** `@fabrika/db` on Zerops: A8–A11 of the [implementation plan](../ideas/app-framework-implementation-plan.md).

**Theme.** Row-level isolation between users and scopes. Run by the [orchestration](../ideas/app-framework-orchestration.md).

## Refs re-verified at HEAD (2026-10-08)

Each work unit re-verifies the plan's facts it depends on before coding.

## Work units

| WU  | State                  | Commits / note |
| --- | ---------------------- | -------------- |
| A8a | in review fixes        |                |
| A8b | queued (after A3, A8a) |                |
| A9  | queued (after A8a)     |                |
| A10 | queued (after A8b)     |                |
| A11 | queued (after A10)     |                |

## Out of scope (explicit)

Per-application Postgres roles and RLS (D2); streaming.

## Decisions

- H3: A8 is split into A8a and A8b. H5: `kysely` 0.29.6 and `kysely-postgres-js` 5.0.1 over `Bun.SQL` with
  `prepare: false`.
- A8a review: a mutation returns an acknowledgement (`{ id, version }`), never row fields; every containment link of
  a Ref's chain is enforced; inputs are read through own data properties only.

## Sequencing

A8a → A9; A8a + A3 → A8b → A10 → A11.

## Run log

- 2026-10-08: A8a landed after one fix round; a second review on `main` found column-role overlaps, caller-owned
  array methods, mutable-prototype checks and BIGINT versions — fixed as A8a.2. Accepted limit: same-process code
  that patches built-ins used while building the query (documented in `packages/db/CLAUDE.md`).
- 2026-10-08: A9 landed after one fix round: the runner refuses transaction-control and setting statements lexically
  and verifies the transaction and settings after each file. Squawk and destructive-migration rules are deferred.
- 2026-10-09: A8b landed after one fix round: the data layer binds only through framework-owned state
  (`@fabrika/db/framework`, refused for applications by the checker); the locator is framework-only.
- 2026-10-09: A10 landed after one fix round: a `Within` carries its container grants and the store judges them in
  the same statement (a moved scope is out of reach); at most 1000 values per `Within`.
