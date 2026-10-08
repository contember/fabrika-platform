# Application framework and platform enforcement: orchestration

How agents execute the [implementation plan](app-framework-implementation-plan.md): who works on what, in which
worktree, in which order, and where a human decides. The plan says _what_ to build; this document says _how to run
it_. It changes no decision, dependency or acceptance of the plan, except one proposed split of A8 (marked below).

**Rule from the plan, applied to the process:** no new tools or services. Orchestration uses Git worktrees, the
sprint files in `docs/sprints/`, the existing checks and ordinary agent sessions.

## Contents

1. [Prerequisite: land the open branches](#prerequisite-land-the-open-branches)
2. [Streams and lanes](#streams-and-lanes)
3. [Roles](#roles)
4. [Branches, worktrees and merging](#branches-worktrees-and-merging)
5. [The loop for one work unit](#the-loop-for-one-work-unit)
6. [Lane queues](#lane-queues)
7. [Critical paths](#critical-paths)
8. [Gates](#gates)
9. [Human checkpoints](#human-checkpoints)
10. [Sprints and the run log](#sprints-and-the-run-log)
11. [Concurrency and CPU](#concurrency-and-cpu)
12. [Failure handling](#failure-handling)
13. [Running a lane as a workflow](#running-a-lane-as-a-workflow)

## Prerequisite: land the open branches

Two branches were not on `main` at `ce3fa5b8`:

| Branch                   | State                                                   | Overlap with this plan                                                                     |
| ------------------------ | ------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `mcp-authoring`          | Work done, operator acceptance open; base `3a4e76b8`    | `auth-core/src/{token,oauth,types}.ts`, `proxy-core`, `control`, `iam`, migration `0002_*` |
| `sprint/local-hardening` | Sprint closed (`080013ae`); base `4bb81292`, 10 commits | `packages/iam` admin RPC (`principalId`), `src/rpc.ts`, `control`, `local-stack`           |

**G0, in this order, before any code work unit of the plan starts:**

1. `mcp-authoring` lands on `main` as its commits, after the full gate on the result.
2. `sprint/local-hardening` is **ported, not merged**. `main` moved 154 commits since its base (three simplification
   sprints, squashed migrations, deleted packages), and a trial merge conflicts in 63 files. Each of its work units
   is redone on the current `main` as one work unit, with the old commit as a guide: backlog 57, 80, 84, 88, 79, 78,
   89 (residual), 81. Backlog 82 is ported too; A12 builds on it. Its migrations are rewritten as new files after
   the squashed baselines. The branch and its worktree are deleted afterwards.

Until G0, agents may do only what touches no code: A0 and B0 drafts, and the verify-first spikes of A7 and A8
(scratch code outside the repository).

## Streams and lanes

The plan has two **streams**: part A (the framework) and part B (enforcement). They are units of _value_ and of
milestones. Work is not assigned by stream. It is assigned by **lane**. A lane owns a set of packages. Only one
agent edits a lane's packages at a time, so merges stay small.

| Lane             | Owns                                                                                                                             | Work units (stream)                                        |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| **L1 Framework** | `packages/app`, the contract model in `packages/auth-core`                                                                       | A1–A6, A13, framework sides of A14–A16 (A)                 |
| **L2 Checker**   | new `packages/check`                                                                                                             | A7 (A), B1 (B)                                             |
| **L3 Data**      | new `packages/db`, `packages/platform-node` (migrations, S3 port)                                                                | A8–A11, the storage port of A14, the job runner of A15 (A) |
| **L4 IAM**       | `packages/iam`, `packages/iam-contract`, `packages/auth`                                                                         | P0.2, P0.3 (0), B5 (B), A12 (A), IAM side of B9 (B)        |
| **L5 Proxy**     | `packages/proxy-core`, `packages/proxy`, `provider-cloudflare/src/proxy-worker.ts`                                               | P0.1 proxy side (0), B2–B4 (B)                             |
| **L6 Delivery**  | `packages/control`, `packages/provider-zerops`, `packages/provider-cloudflare` (except the proxy worker), `packages/local-stack` | P0.4 (0), A4 provider wiring (A), B6–B9 (B), B10 (B)       |
| **Docs**         | `docs/decisions`, `docs/reference`, CLAUDE.md files                                                                              | A0, B0, A17 skill text                                     |

The IAM lane is the clearest case. P0.2, P0.3, B5 and A12 come from three parts of the plan, but all of them edit
`packages/iam`. One lane runs them one after another.

**Shared files.** Several lanes add to `packages/auth-core`:

- L1: the contract model, `planEndpoint`, `satisfies`.
- L5: `requirementDigest`, and the `X-Fabrika-*` list in `wire.ts`.
- L4: the `<app>@<env>` helper.
- P0.1: `isCanonicalPath`.

Each addition is a new module plus one export line. It lands in its own first commit and merges to `main` before
the consumer's commits. A lane that must change an _existing_ `auth-core` module asks the integrator to hold L1 for
the time of that merge.

**Provider files shared by L5 and L6.** B2 changes the manifest producers (`provider-zerops/src/namespace/manifest.ts`,
`local-stack/src/prepare.ts`). L5 makes these edits in B2, and L6 waits on them. P0.3 (L4) and P0.4 (L6) both edit
`provider-cloudflare/src/plan.ts`. P0.4 merges first.

## Roles

| Role            | Who                                                                        | Does                                                                                                                | Does not                                          |
| --------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| **Integrator**  | One long-lived session in the main worktree                                | Keeps the sprint files and run logs; starts and stops lanes; merges to `main`; runs milestone gates; asks the owner | Writes feature code                               |
| **Implementer** | One agent per active work unit, in its lane's worktree                     | Verify-first, code, the witness tests and checks of one work unit; one commit series                                | Edits another lane's packages; changes a decision |
| **Reviewer**    | A fresh agent per work unit, of a different model family (the `gpt` agent) | Reviews the diff against the work unit text, the ADRs and CLAUDE.md; returns findings                               | Edits code                                        |
| **Owner**       | The human                                                                  | Merges G0; approves ADR text; resolves the checkpoints below; runs operator acceptance                              | —                                                 |

The implementer starts cold. Its prompt is the work unit's text copied from the sprint file, the paths of the
documents it must read (the root, package and `docs/` CLAUDE.md files, the ADRs the work unit names, the relevant
sections of the two idea documents), and the lane's ownership list. It does not get the history of this
conversation.

## Branches, worktrees and merging

- One worktree per active lane: `../fabrika-platform-<lane>` (for example `../fabrika-platform-iam`).
- One branch per work unit, from the current `main`: `wu/<id>-<slug>` (for example `wu/b5-iam-restrictions`).
- The implementer commits on that branch in the repository's style (`feat(iam): …`), atomically, with explicit paths.
- **Merge unit = one work unit.** When its gates pass, the integrator rebases the branch onto `main`. If `main` moved,
  it re-runs the work unit gate, then runs `git merge --ff-only` in the main worktree. There are no long-lived stream
  branches. Part B sees part A's code as soon as it is on `main`.
- A lane rebases onto `main` before it starts its next work unit.
- The `mcp-spike` worktree is not used for this work.

## The loop for one work unit

1. **Brief.** The integrator copies the work unit from the plan into the milestone's sprint file and re-verifies its
   facts at HEAD (✔/⚠ with `file:line`). It starts the implementer.
2. **Verify first.** The implementer runs the work unit's verify-first checks. If a result contradicts the plan, the
   implementer stops and reports. The integrator records it and asks the owner (a checkpoint).
3. **Witness first.** The implementer writes the deny rows and the failing witness tests before the code that makes
   them pass (the plan's "fail-closed first").
4. **Implement** until the work unit gate passes.
5. **Review.** A fresh reviewer gets the diff (`git diff main...wu/<id>`), the work unit text and the document list.
   It checks:
   - the witness exists, and fails when the core change is reverted (one spot check per work unit);
   - deny rows exist for every decision step;
   - no `as`, `any`, `@ts-ignore`, `@ts-expect-error`;
   - no second gate evaluator: the vocabulary of `docs/reference/overview.md` (gate, authorization, admission);
   - no logged secret or credential;
   - no private repository or client name;
   - comments follow CLAUDE.md;
   - the scope matches the work unit: nothing more, nothing less.
6. **Fix round.** The implementer fixes the findings or answers each one. A finding that both disagree on goes to
   the owner. At most two rounds. After that the work unit is blocked (see [failure handling](#failure-handling)).
7. **Merge** (as above) and one run-log line: the commits, the gate result, any deviation.

## Lane queues

Each lane takes its next work unit when that unit's "Starts when" is met. Lanes do not wait for each other in
waves. "on `main`" means merged.

**L1 Framework**

| Order | Work unit                                                           | Starts when                                        |
| ----- | ------------------------------------------------------------------- | -------------------------------------------------- |
| 1     | A1 contract model and matcher                                       | G0, A0 approved, P0.1 on `main`                    |
| 2     | A2 `defineContract`                                                 | A1 on `main`                                       |
| 3     | A3 `implement`, `boot`, dispatch                                    | A2 on `main`                                       |
| 4     | A5 client, A6 test kit                                              | A3 on `main` (A5 and A6 may run in one work unit)  |
| 5     | A4 app side (`gatesFromContract`, `schemaFromContract`, entrypoint) | A3 on `main`; L6 does the provider wiring after it |
| 6     | A13 members, links, anonymous kinds                                 | A10 and A12 on `main`                              |
| 7     | Framework sides of A14, A15, A16                                    | A10 on `main`; A15, A16 also A12                   |
| 8     | A17 template and examples (with Docs)                               | A14–A16 on `main`                                  |

**L2 Checker**

| Order | Work unit                                   | Starts when                    |
| ----- | ------------------------------------------- | ------------------------------ |
| 0     | A7 verify-first: the parser spike (scratch) | now                            |
| 1     | A7 the checker                              | G0, parser chosen (checkpoint) |
| 2     | B1 the static reader                        | A2 and A7 on `main`            |

**L3 Data**

| Order | Work unit                                                                                    | Starts when                 |
| ----- | -------------------------------------------------------------------------------------------- | --------------------------- |
| 0     | A8 verify-first: `kysely-postgres-js` over `Bun.SQL` (scratch)                               | now                         |
| 1     | **A8a** tables, stores, the description builder, the `OperationNode` guard, the attack suite | G0                          |
| 2     | A9 migrations and codegen                                                                    | A8a on `main`               |
| 3     | **A8b** request binding and action checks through `Ref` and `Within`                         | A3 and A8a on `main`        |
| 4     | A10 locators                                                                                 | A8b on `main`               |
| 5     | A11 database test kit                                                                        | A10 on `main`               |
| 6     | A14 storage port, A15 job runner                                                             | A10 on `main`; A15 also A12 |

The split of A8 into A8a and A8b was confirmed on 2026-10-08. The data lane starts at G0 instead of after A3.

**L4 IAM**

| Order | Work unit                                   | Starts when                                 |
| ----- | ------------------------------------------- | ------------------------------------------- |
| 1     | P0.2 key issuing                            | G0                                          |
| 2     | P0.3 narrow Cloudflare entrypoint           | P0.2 on `main`, P0.4 on `main`              |
| 3     | B5 IAM restrictions                         | P0.3 on `main`, B0's ADR-0022 text approved |
| 4     | A12 multi-tenant features                   | B5 on `main`                                |
| 5     | B9 IAM side (kinds `job`, `webhook`, `app`) | A12 on `main`                               |

B5 goes before A12 on purpose. A12 adds new grant types on top of the restricted model, and doing it in the other
order would mean writing the grant paths twice.

**L5 Proxy**

| Order | Work unit                                       | Starts when                                      |
| ----- | ----------------------------------------------- | ------------------------------------------------ |
| 1     | P0.1 canonical paths (auth-core, router, proxy) | G0                                               |
| 2     | B2 per-endpoint decision and digests            | A1 and A3 on `main`, B0's ADR-0022 text approved |
| 3     | B3 stripping and the proxy secret               | B2 on `main`                                     |
| 4     | B4 headers at the proxy                         | B3 on `main`                                     |

P0.1 also touches `packages/app/src/router.ts` (L1's package). It runs before L1 starts, so there is no
conflict.

**L6 Delivery**

| Order | Work unit                          | Starts when                                                 |
| ----- | ---------------------------------- | ----------------------------------------------------------- |
| 1     | P0.4 provider refusals             | G0                                                          |
| 2     | A4 provider wiring                 | A4 app side on `main`                                       |
| 3     | B6 snapshots and approval          | B1 and B2 on `main`, ADR-0050 approved                      |
| 4     | B8 Cloudflare lock-down            | B2 on `main`                                                |
| 5     | B7 Zerops lock-down                | A4, A9 and B1 on `main`; Zerops facts recorded (checkpoint) |
| 6     | B9 credentials and connector edges | A12, A15, A16 and B6 on `main`                              |
| 7     | B10 platform services on contracts | B-M1 and B-M2 closed                                        |

**Docs**

| Order | Work unit                       | Starts when                                                  |
| ----- | ------------------------------- | ------------------------------------------------------------ |
| 1     | A0 binding documents for part A | now (draft); merged at G0                                    |
| 2     | B0 ADR rewrites and ADR-0050    | now (draft); each ADR approved before the lanes that need it |
| 3     | A17 skill text                  | A13 on `main`                                                |
| —     | Reference and CLAUDE.md updates | in the work unit that changes the behaviour, not later       |

## Critical paths

1. **To B-M1 (the binding contract):** G0 → P0.1 → A1 → A2 → A3 → B2 → B6. B6 also waits for A7 → B1. L1 and L5 set
   the pace; L2 must finish B1 by the time B2 lands.
2. **To A-M3 (multi-tenant):** G0 → P0.2 → P0.3 → B5 → A12 → A13. The IAM lane is the bottleneck. B5 is there
   because of the order above. If the owner wants A-M3 before B-M1, A12 may go before B5, and the duplicate work is
   accepted.
3. **To A-M2 (data):** G0 → A8a → (A3) → A8b → A10 → A11. With the proposed split it is not on the critical path.

Approximate parallelism: four lanes at a time (L1, L2, L3, L4) from G0 until A3. Then L5 and L6 join, and L2 goes
idle after B1.

## Gates

| Gate           | When                                    | Command or check                                                                                                                                                                                                                                          |
| -------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Work unit**  | Before review, and again after a rebase | `bun run typecheck`; `bun test` on the touched packages; `bun run lint`; `bun run format:check`; Postgres and S3 suites **with** `FABRIKA_TEST_POSTGRES_URL` and `FABRIKA_TEST_S3_*` set when the work unit touches them (a skipped suite does not count) |
| **Merge**      | Before `--ff-only`                      | The work unit gate is green on the rebased branch; the reviewer has no open findings                                                                                                                                                                      |
| **Milestone**  | Before a sprint closes                  | Full `bun run test` with both backends; `bun run local:up` and `bun run local:smoke`; the milestone's opice suites; `bun run release:validate` when a package is added                                                                                    |
| **Production** | After A-M2 or B-M1                      | The production guidance of the plan; the owner decides                                                                                                                                                                                                    |

Full runs go through `cpu-lease run -n 4 -- …`. A work unit gate uses `-n 2`.

## Human checkpoints

The integrator collects these and asks one at a time, each with context, options and a recommendation. A lane that
waits on a checkpoint takes its next independent work unit, or idles.

| #   | Checkpoint                                                                                                                                                          | Blocks                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| H1  | Merge `sprint/local-hardening` and `mcp-authoring` (G0)                                                                                                             | all code                    |
| H2  | A0 text (ADR-0012, package CLAUDE.md files)                                                                                                                         | A1                          |
| H3  | The A8a/A8b split                                                                                                                                                   | L3 before A3                |
| H4  | The parser for A7 and B1                                                                                                                                            | A7                          |
| H5  | The Kysely dialect over `Bun.SQL`                                                                                                                                   | A8a                         |
| H6  | B0 ADR texts, one by one (0022 first, 0050 before B6)                                                                                                               | B2, B5, B6, B7              |
| H7  | How a password-only installation verifies an email (A12)                                                                                                            | A12 invitations             |
| H8  | The connector document's open questions (A16)                                                                                                                       | A16                         |
| H9  | Zerops facts that need a live account (B7): exec readiness, `initCommands` failure; the owner sets `FABRIKA_LIVE_ZEROPS_TOKEN` and `FABRIKA_LIVE_ZEROPS_PROJECT_ID` | B7                          |
| H10 | Any schema change that requires reinstalling an installation                                                                                                        | the merge of that work unit |
| H11 | Milestone close and the production decision                                                                                                                         | the next milestone's sprint |
| H12 | Operator acceptance: a real Zerops build, a real GitHub App, a real MCP client                                                                                      | closing B-M1 and A-M4       |

Anything the plan does not decide, and anything that would change architecture, data flow or module boundaries,
is a checkpoint too (root CLAUDE.md). An implementer never resolves it alone.

## Sprints and the run log

- One sprint file per milestone, created when its first work unit starts:
  `docs/sprints/sprint-YYYY-MM-DD-<theme>.md` from the template. Several are active at once. For example, M0,
  A-M1 and part of B-M1 overlap.
- The sprint holds the work units copied from the plan, with facts re-verified at HEAD on the day it starts.
- The integrator writes the run log: one line per merged work unit, every deviation, and every checkpoint and its
  answer. Implementers report to the integrator. They do not edit sprint files, so the docs never conflict.
- Each run-log entry graduates as `docs/CLAUDE.md` says: a changed _why_ goes into the ADR, and new work becomes a
  backlog item.
- When a milestone closes, the integrator writes the OUTCOME header, moves the sprint to `docs/archive/` and deletes
  the work units it consumed from the plan. When the last milestone closes, the idea documents are deleted (their
  content lives in ADRs and reference).

## Concurrency and CPU

- At most four implementers at once. The CPU pool has 8 vCPU, a work unit gate leases 2, and the owner's other
  sessions share the pool.
- Reviewers read and do not run the full suite. They may run one targeted test file.
- The local stack (`local:*`) is one per machine. Only the integrator runs it, at milestone gates.

## Failure handling

| Situation                                   | Action                                                                                 |
| ------------------------------------------- | -------------------------------------------------------------------------------------- |
| Verify-first contradicts the plan           | Stop the work unit; run-log entry; checkpoint                                          |
| Two review rounds without agreement         | The work unit is blocked; the integrator summarises both positions for the owner       |
| A gate fails after a rebase                 | The implementer fixes it on the branch; the work unit is not merged red                |
| A flaky or environment failure              | Retry after a minute; no `git stash`, no revert of another lane's work                 |
| A lane needs to edit another lane's package | The integrator holds the owning lane, or moves the change into the owning lane's queue |
| A work unit grows beyond its size           | Split it at a commit boundary; the remainder becomes the next item in the same lane    |
| A backend is missing (Postgres, S3, Zerops) | Ask the owner to provide it; never accept a skipped suite as green                     |

## Running a lane as a workflow

The loop above can run in ordinary agent sessions, which is the default. If the owner asks for it, one lane step
can instead run as a workflow script with three stages: implement, review, then fix. That is three or four agents
per work unit, below the size guideline. Several work units of independent lanes may run in one workflow. The
integrator still merges by hand and asks the checkpoints. A workflow never merges to `main` and never answers a
checkpoint.
