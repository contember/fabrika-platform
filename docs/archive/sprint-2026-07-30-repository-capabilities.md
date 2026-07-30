# Sprint — Repository capabilities (2026-07-30)

## OUTCOME

Shipped operation-level SQL portability seams for IAM and control without duplicating their portable
query surfaces.

- `5d3d3f7` splits both monolithic database classes into statically composed capability repositories,
  updates all callers, and records the boundary in ADR-0015.

Verification:

- IAM and control SQLite suites passed 405 tests; 54 Postgres-dependent tests skipped when their
  backend was absent.
- The real-Postgres IAM and control suites passed all 54 tests.
- IAM and control package typechecks passed.
- Targeted lint completed with no errors. Format and `git diff --check` passed.
- The workspace typecheck reached the affected packages successfully, then failed in unrelated
  concurrent `iam-ui` route moves.

No sprint work was deferred. Dialect-specific subclasses remain intentionally absent until an
operation has a real correctness, atomicity, or performance reason to diverge.

**Goal.** Split IAM and control persistence into capability repositories whose implementations can
diverge by runtime at the operation boundary.

**Theme.** Preserve shared SQL where it is genuinely portable while making backend-specific operation
shapes explicit and statically composed.

## Refs re-verified at HEAD (2026-07-30)

- ✔ IAM persistence is one `Db` with about 50 public methods across six independent sections —
  `packages/iam/src/db.ts:200`.
- ✔ Control persistence is one `Db` across apps, namespaces, environments, configuration, runs, and
  polling — `packages/control/src/db.ts:184`.
- ✔ Both runtime composition roots currently expose only `Env.DB`; shared service assembly constructs
  `new Db(env.DB)` — `packages/iam/src/services.ts:59`,
  `packages/control/src/services.ts:16`.
- ✔ Real-Postgres suites already drive the shipped query surfaces, but skip without
  `FABRIKA_TEST_POSTGRES_URL` — `packages/iam/src/__tests__/postgres-schema.test.ts:1`,
  `packages/control/src/__tests__/postgres-schema.test.ts:1`.

## Work units

### WU1 — Define the repository portability boundary (effort S)

- **Problem.** The common SQL subset is a hard boundary even when one domain operation should use
  different statement shapes.
- **Verify first.** Confirm no accepted ADR requires one query body.
- **Scope.** Record repository operations as the dialect seam and retain shared implementations as
  the default.
- **Acceptance / witness.** ADR-0015 is indexed and the portability reference describes the new seam.
- **Touch points.** `docs/decisions/`, `docs/reference/portability-surface.md`.

### WU2 — Split IAM persistence capabilities (effort L)

- **Problem.** Principals, grants, app vocabulary, credentials, sessions, and audit share one large
  concrete class.
- **Verify first.** Inventory every public method and caller.
- **Scope.** Extract focused repositories, assemble a statically selected bundle, and update IAM
  services and tests without changing behaviour.
- **Acceptance / witness.** IAM SQLite tests and the real-Postgres schema/query suite pass.
- **Touch points.** `packages/iam/src/db.ts`, service assembly, entrypoints, tests.

### WU3 — Split control persistence capabilities (effort L)

- **Problem.** Registry, namespace, run, and polling persistence share one large concrete class.
- **Verify first.** Inventory cross-section atomic operations before selecting boundaries.
- **Scope.** Extract focused repositories, keep cross-resource atomic operations with their owning
  capability, assemble a statically selected bundle, and update callers/tests without behaviour
  changes.
- **Acceptance / witness.** Control SQLite tests and the real-Postgres schema/query suite pass.
- **Touch points.** `packages/control/src/db.ts`, service assembly, entrypoints, tests.

### WU4 — Verify and document the resulting surface (effort M)

- **Problem.** Type compatibility alone cannot prove equal database behaviour.
- **Verify first.** Confirm CPU lease availability and Postgres test configuration.
- **Scope.** Format, lint, typecheck, run focused and full tests, and update living reference docs.
- **Acceptance / witness.** All available gates pass; unavailable real-backend coverage is reported
  explicitly.
- **Touch points.** Repository tests, `docs/reference/portability-surface.md`, sprint archive.

## Out of scope (explicit)

- Introducing a dialect-specific query where no real behavioural or performance need exists.
- Changing SQL schemas or migration history.
- Replacing the D1-shaped `SqlDatabase` port or adopting a query builder.

## Decisions

- Repository operations, not prepared queries, are the portability seam. See
  [ADR-0015](../decisions/0015-repository-operations-are-the-sql-portability-seam.md).
- Capability implementations stay shared until a real dialect divergence exists.
- Runtime composition selects the repository bundle without a backend discriminator in business
  logic.

## Sequencing

WU1 establishes the constraint. WU2 and WU3 then apply it independently. WU4 verifies and closes the
sprint.

## Run log

- → ADR-0015.
- IAM now composes six capabilities; control composes registry, run, and polling capabilities.
- SQLite suites: 405 passed, 54 Postgres-dependent tests skipped, 0 failed.
- Real Postgres suites: 54 passed, 0 failed.
- IAM and control package typechecks pass. The workspace typecheck reaches those packages but currently
  fails in unrelated concurrent `iam-ui` route moves.
