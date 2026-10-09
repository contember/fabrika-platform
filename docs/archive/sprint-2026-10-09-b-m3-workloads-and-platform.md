> **OUTCOME — shipped 2026-10-09.** Workloads hold narrow credentials and the whole installation follows one model.
> B9a issues `job` and `webhook` keys from the approved snapshot, rotated on deploy, exchanged at
> `POST /auth/workload/token`; a workload principal never resolves grants. B9b adds connector edges with compatibility
> checks and `app:<consumer>` keys per edge, and absorbs the Cloudflare connector binding (F4). F3 gives Zerops
> applications IAM's membership transport. B10 puts IAM, Control and Operations on installation endpoint tables
> (`@fabrika/app/service`), replaces Control's same-origin guards with proxy admission, refuses an application without
> a contract, and deletes gates, the gate matcher and `@fabrika/app`'s request pipeline; ADR-0022 now describes one
> proxy form plus installation entries. Commit map: B9a → `3febdffc`…`8c78de0f`, B9b → `c64f2196`…`fd20ec44`,
> F3 → `83d9736b`…`50a655bf`, B10a → `1165de3f`…`139dbadb`, B10b → `655a90d9`…`16f24546`, B10c+d →
> `c40d2aaf`…`b7a5af56`, B10e+f → `01e985ab`…`805b595b`, B10g → `269576c7`…`d63fabba`, B10h → `76d48106`…`05428241`.
> Each unit had an independent review and at most two fix rounds; B10 was planned and reviewed as an architecture
> before coding. Verification: full `bun run test` at each merge (last: 6240 pass, 38 skip — live Zerops only — 0 fail),
> the browser suite 11/11 on B10h, and `bun run local:reset && bun run local:smoke` on main after B10h (run
> `01a121c4-b59e-70a4-a043-8deb6cbb37c9`). Deferred: authenticated job reports to Operations (backlog 96), the unused
> `runs.pending_access_json` column (backlog 103), the browser's Operations DSN on Zerops (backlog 102), per-edge quotas.

# Sprint — B-M3: workloads and platform (2026-10-09)

**Goal.** Narrow workload credentials and one model for the whole installation: B9–B10 of the application framework
implementation plan.

**Theme.** Part B's last milestone, run by the application framework orchestration.

## Work units

| WU     | State  | Commits / note                                                                       |
| ------ | ------ | ------------------------------------------------------------------------------------ |
| B9a    | landed | `3febdffc`…`8c78de0f` — job and webhook keys, kinds at the proxy, Control reconcile  |
| B9b    | landed | `c64f2196`…`fd20ec44` — connector edges and compatibility, `app:<consumer>` keys, F4 |
| F3     | landed | `83d9736b`…`50a655bf` — Zerops IAM membership transport for applications             |
| B10a   | landed | `1165de3f`…`139dbadb` — installation-only endpoint forms, digest compatibility       |
| B10b   | landed | `655a90d9`…`16f24546` — `@fabrika/app/service`, service proxy tables                 |
| B10c+d | landed | `c40d2aaf`…`b7a5af56` — Operations and IAM on endpoint tables                        |
| B10e+f | landed | `01e985ab`…`805b595b` — Control on its table; proxy admission replaces origin guards |
| B10g   | landed | `269576c7`…`d63fabba` — an application deploys only with a contract                  |
| B10h   | landed | `76d48106`…`05428241` — gates, the gate matcher and the request pipeline deleted     |

## Out of scope (explicit)

Per-edge quotas; authenticated job reports to Operations (backlog 96).

## Decisions

- B9 split into B9a and B9b by the implementer. One key per webhook declaration (bindings are created at runtime).
  Keys rotate on deploy and live at most 30 days; an environment idle for 30 days loses its workload keys.
- New public IAM route `POST /auth/workload/token`; the key is the authority. A workload principal never resolves grants.
- B10: the console SPA admits a user API key as well as a session (accepted widening of a static shell); `/webhooks`
  and `/mcp` are reserved prefixes; bearer calls no longer need same-origin metadata (session admission is the
  proxy's); private hops are private `protocol` rows; existing application digests stay byte-identical.
- B10g keeps the trusted installation deploy path; `runs.pending_access_json` stays until old consumers retire
  (backlog 103).
- B10h keeps providers' `defineApp` (it describes resources), the RPC library and IAM's `sameOrigin`; legacy `gates`
  keys are refused, never served.

## Sequencing

B9a → B9b ∥ F3 → B10a → B10b → B10c+d → B10e+f → B10g → B10h.

## Run log

- A dogfood CRM built on the framework after B10h found three framework bugs, fixed in `861b1bcd` and `c3c24b8c`
  (`fabrika job run` without object storage; the isolation seed's date and defaulted columns).
