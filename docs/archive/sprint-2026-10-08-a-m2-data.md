> **OUTCOME — shipped 2026-10-09.** The scoped data layer on Zerops: `@fabrika/db` over Kysely and `Bun.SQL` with
> table policies, the whole containment chain and acknowledgement-only mutations (A8a); request binding through
> framework-owned state only (A8b); application migrations with checksums, timeouts and a transaction guard, plus
> codegen (A9); generated locators for `in` and `over`, with a `Within`'s container grants judged in the statement
> (A10); the database test kit, generated policy-isolation and endpoint-access tests, and `fabrika db test-isolation`
> run by the platform at container start (A11). Commit map: A8a → `d0ceba07`…`ca63c588`, A9 → `2b336f5f`…`756c4dc9`,
> A8b → `3f3e2103`…`5b5a2a84`, A10 → `8d37e569`…`b1746d25`, A11 → `2b49048c`…`e813ef6a`. Every work unit had an
> independent review and one or two fix rounds. Verification: full `bun run test` with Postgres and S3 at the A11
> merge (5880 pass, 38 skip — live Zerops only, 0 fail), `bun run local:reset && bun run local:smoke` passed (run
> `01a11e42-0ebb-70e8-a4fb-1af42601cb30`). Deferred: `move` coverage in the generated tests; squawk migration rules; the 1000-value cap of a
> `Within` list. The generated tests catch an author's mistakes; the data layer is the enforcement.

# Sprint — A-M2: the scoped data layer (2026-10-08)

**Goal.** `@fabrika/db` on Zerops: A8–A11 of the [implementation plan](../ideas/app-framework-implementation-plan.md).

**Theme.** Row-level isolation between users and scopes. Run by the [orchestration](../ideas/app-framework-orchestration.md).

## Refs re-verified at HEAD (2026-10-08)

Each work unit re-verifies the plan's facts it depends on before coding.

## Work units

| WU  | State  | Commits / note        |
| --- | ------ | --------------------- |
| A8a | landed | `d0ceba07`…`ca63c588` |
| A8b | landed | `3f3e2103`…`5b5a2a84` |
| A9  | landed | `2b336f5f`…`756c4dc9` |
| A10 | landed | `8d37e569`…`b1746d25` |
| A11 | landed | `2b49048c`…`e813ef6a` |

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
- 2026-10-09: A11 landed after two fix rounds: generated tests are compared byte for byte with the scaffold; the
  platform runs them with a captured runner and withheld output; migrations may not name another schema; throwaway
  schemas are held by an advisory lock and reclaimed after a crash; the production mark is process-global.
