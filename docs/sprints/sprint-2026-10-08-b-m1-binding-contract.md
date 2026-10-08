# Sprint — B-M1: the binding contract (2026-10-08)

**Goal.** The proxy enforces endpoints, IAM is restricted, and a widening on production waits for a human: B0–B6 of
the [implementation plan](../ideas/app-framework-implementation-plan.md).

**Theme.** Part B's first milestone. Run by the [orchestration](../ideas/app-framework-orchestration.md).

## Refs re-verified at HEAD (2026-10-08)

Each work unit re-verifies the plan's facts it depends on before coding.

## Work units

| WU | State                 | Commits / note                         |
| -- | --------------------- | -------------------------------------- |
| B0 | landed                | `b5a7e669`…`b100135e` (owner-approved) |
| B1 | in review fixes       |                                        |
| B2 | queued (after A3)     |                                        |
| B3 | queued (after B2)     |                                        |
| B4 | queued (after B3)     |                                        |
| B5 | landed                | `ebcaf8ed`…`f6a14aaa`                  |
| B6 | queued (after B1, B2) |                                        |

## Out of scope (explicit)

B-M2, B-M3. Delegation grants moved: IAM side to A12, proxy side to B2/B3.

## Decisions

- B0 (owner): removal passes only when its paths become denied, and removing a column read policy waits;
  Cloudflare guarantees are a strong default until backlog 86; only contract files, `tables.ts` and `migrations/` open
  up over MCP; the `protected` flag is a column on `app_envs` guarded by `access.approve`.
- B5: platform audiences are a constant plus `ADMIN_AUDIENCES`; the app learns its IAM id from `FABRIKA_IAM_APP_ID`;
  the token bound is 8 KiB; the membership-role rule applies to every app; `listPrincipals` is narrowed until A12's
  `members.list`.

## Sequencing

B1 ∥ B5; A3 → B2 → B3 → B4; B1 + B2 → B6.

## Run log

- 2026-10-08: B5 landed after one fix round. The review found that a Cloudflare graph could choose its proxy
  audience (`notes@stage`, `vozka`); the provider now refuses any audience other than the run's `<app>@<env>`.
- 2026-10-08: B1 landed after one fix round: the reader refuses import mappings that can redirect `@fabrika/*`,
  `zod` or `bun`, ambiguous and directory imports, forward references and import cycles, and bounds its work
  (`CONTRACT_LIMITS`). Paired source/runtime fixtures prove each refused case diverges in Bun.
- 2026-10-09: B2 landed after one fix round: the digest covers the delegation; delegation grants are obtained on
  both providers (new IAM route `POST /auth/mint/delegation` for the Zerops proxy); one caller-kind mapping
  (`callerOf`). Decision: contract apps are always behind their endpoint table; generated gates removed.
