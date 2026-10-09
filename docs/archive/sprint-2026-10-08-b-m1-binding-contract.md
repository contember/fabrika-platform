> **OUTCOME — shipped 2026-10-09.** The contract is binding: the proxy decides every contract application per
> endpoint (canonical path, caller kind, requirement, admission) and asserts `X-Fabrika-Endpoint: <id>@<digest>`;
> every `X-Fabrika-*` hop header is stripped and a per-environment proxy secret reaches the app (Zerops); the proxy sets
> the response header policy and the file treatment; IAM tokens carry only their own app's grants within 8 KiB; and
> Control publishes access only from an approved snapshot, with a widening on a protected environment waiting for a
> human (`access.approve`), for contract and artifact access alike. Commit map: B0 → `b5a7e669`…`b100135e`, B1 →
> `a6ce4147`…`66d67fa2`, B2 → `ae8a5066`…`556a8903`, B3 → `648c5a4b`…`a774d577`, B4 → `445ac72e`…`e1048fc0`, B5 →
> `ebcaf8ed`…`f6a14aaa`, B6 → `35cd0fff`…`08f0a4e3` and B6.3 → `c5af4197`…`c207f685`. Every work unit had an
> independent review; B6 had three. Verification: full `bun run test` with Postgres, S3 and a real Caddy at the B6.3
> merge (6101 pass, 38 skip — live Zerops only, 0 fail), `bun run local:reset && bun run local:smoke` passed with one
> console approval (run `01a11ec7-4b50-7057-aa82-f91a09557264`). Deferred: the operator acceptance of H12 (a real
> Zerops build, a real GitHub App, a real MCP client) and the unverified Zerops platform rows need a live account.

# Sprint — B-M1: the binding contract (2026-10-08)

**Goal.** The proxy enforces endpoints, IAM is restricted, and a widening on production waits for a human: B0–B6 of
the [implementation plan](../ideas/app-framework-implementation-plan.md).

**Theme.** Part B's first milestone. Run by the [orchestration](../ideas/app-framework-orchestration.md).

## Refs re-verified at HEAD (2026-10-08)

Each work unit re-verifies the plan's facts it depends on before coding.

## Work units

| WU   | State  | Commits / note                         |
| ---- | ------ | -------------------------------------- |
| B0   | landed | `b5a7e669`…`b100135e` (owner-approved) |
| B1   | landed | `a6ce4147`…`66d67fa2`                  |
| B2   | landed | `ae8a5066`…`556a8903`                  |
| B3   | landed | `648c5a4b`…`a774d577`                  |
| B4   | landed | `445ac72e`…`e1048fc0`                  |
| B5   | landed | `ebcaf8ed`…`f6a14aaa`                  |
| B6   | landed | `35cd0fff`…`08f0a4e3`                  |
| B6.3 | landed | `c5af4197`…`c207f685`                  |

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
- 2026-10-09: B3 landed after one fix round: one strip list `FABRIKA_HOP_HEADERS`; the proxy secret is compared in
  constant time, exempts health, and is read by Caddy from `{env.FABRIKA_PROXY_SECRET_<hash>}`.
- 2026-10-09: B4 landed after one fix round: the proxy replaces the app's security headers, drops reporting headers
  and 1xx headers, and gives downloads the file treatment; `Permissions-Policy` is recorded in ADR-0022.
- 2026-10-09: B6 landed after two fix rounds; a third review on `main` found concurrency gaps, fixed as B6.3: a
  coordinate lock on `app_env_protection`, protection changes under the deployment lease, one captured access per
  Cloudflare deploy, a canonical access digest, and an approval diff that lists every IAM schema field.
