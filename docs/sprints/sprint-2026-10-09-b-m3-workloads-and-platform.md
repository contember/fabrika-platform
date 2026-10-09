# Sprint — B-M3: workloads and platform (2026-10-09)

**Goal.** Narrow workload credentials and one model for the whole installation: B9–B10 of the
[implementation plan](../ideas/app-framework-implementation-plan.md).

**Theme.** Part B's last milestone. Run by the [orchestration](../ideas/app-framework-orchestration.md).

## Refs re-verified at HEAD (2026-10-09)

Each work unit re-verifies the plan's facts it depends on before coding.

## Work units

| WU  | State                 | Commits / note                                                       |
| --- | --------------------- | -------------------------------------------------------------------- |
| B9a | in review fixes       | job and webhook keys, kinds at the proxy, Control reconcile          |
| B9b | queued (after B9a)    | connector edges and compatibility, `app:<consumer>` keys, F4         |
| F3  | queued (after B9a)    | Zerops IAM membership transport for applications                     |
| B10 | queued (after B9, F3) | IAM, Control and Operations on contracts; gates and `defineApp` gone |

## Out of scope (explicit)

Per-edge quotas; authenticated job reports to Operations (backlog 96).

## Decisions

- B9 split into B9a and B9b by the implementer. One key per webhook declaration (bindings are created at runtime).
  Keys rotate on deploy and live at most 30 days; an environment idle for 30 days loses its workload keys.
- New public IAM route `POST /auth/workload/token`; the key is the authority. A workload principal never resolves grants.

## Sequencing

B9a → B9b ∥ F3 → B10.

## Run log
