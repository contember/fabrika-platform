> **OUTCOME — shipped 2026-10-09.** The platform owns each contract application's run section and build on Zerops
> (B7): it generates the build order (SPA commands, install, the authored tests, reinstall, the entrypoint, the checker,
> `tsc`) and the start script (`migrate`, `codegen --verify`, `db test-isolation`, serve), refuses impersonation,
> exposure and `startWithoutCode`, and reads exposure and bucket provenance back. On Cloudflare (B8) the checks run on
> the generated wrangler configs, the platform builds every application's proxy Worker, and bindings to another
> application's names are refused. Commit map: B7 → `bca812b2`…`b32f4e23`, B8 → `df830af5`…`fe311795`. Each had an
> independent review and one fix round. Verification: full `bun run test` at each merge and `bun run local:reset &&
> bun run local:smoke` passed at the B-M1 close (run `01a11ec7-4b50-7057-aa82-f91a09557264`). Deferred: the checker and
> type checks stay advisory on Cloudflare until the runner separates a credential-free step (backlog 86); two Zerops
> activation facts are live rows that need a real account (H9).

# Sprint — B-M2: locked providers (2026-10-09)

**Goal.** The platform owns the run section and the build; exposure is refused and read back: B7–B8 of the
[implementation plan](../ideas/app-framework-implementation-plan.md).

**Theme.** Part B's second milestone, run in parallel with B-M1 by the
[orchestration](../ideas/app-framework-orchestration.md). This file was written at close; the work units ran from the
orchestration's briefs.

## Work units

| WU | State  | Commits / note        |
| -- | ------ | --------------------- |
| B7 | landed | `bca812b2`…`b32f4e23` |
| B8 | landed | `df830af5`…`fe311795` |

## Decisions

- B7: tests run before final validation; bucket evidence is kept in the stored target; `codegen --verify` runs at
  start; TOML preload is refused.
- B8: the platform builds the proxy for every application; gate applications pass `defineApp({ gates })`; the graph is
  normalised to the runner's oblaka classes.
