# Sprint — platform feedback loops (2026-11-02)

**Goal.** The platform tells the people and agents who change an application what their change did: whether it widens
access, what breaks after it ships, what a reviewer said about it, and who acted when an agent did.

**Theme.** Seven features, each designed in its own [spec](../specs/README.md). They share one shape: data the platform
already holds (approved access, Operations issues, IAM grants, the registry) reaches the person or agent at the moment a
decision is made, through surfaces that exist (the console, the GitHub App, the authoring MCP, the proxy). None adds a
service. The batch succeeds when an agent can deploy a workspace, read the errors of that deploy and a reviewer's
comments on it, and a person can see on the pull request and in the console what the change widened, whether its
release looks suspect and whether rolling it back is safe.

The specs were reviewed on 2026-11-04 and their open questions decided ("Decisions"). Each spec records the decisions
that concern it under its own "Decisions" heading; the rest of its open questions run on their recommended defaults.

## Refs re-verified at HEAD (2026-11-04, `0edd21d62`)

Each spec carries its own citations; these are the facts the order depends on.

- ✔ The authoring MCP has 18 tools and no Operations tool — `packages/control/src/mcp/handler.ts:218-405`.
- ✔ The `authoring` scope grants five Control actions and no `operations.*` action —
  `packages/platform-artifacts/src/proxy-manifest.ts:59-72`.
- ✔ The console's `/mcp` row requires the `authoring` scope, and the proxy admits a resource token only with every
  listed scope — `packages/control/fabrika.service.ts:60`, `packages/proxy-core/src/authorize.ts:446`. A task key
  therefore always carries `authoring`.
- ✔ Operations verifies only the console's own tokens (app `vozka`) — `packages/operations/src/auth.ts:23`.
- ✔ An OAuth grant resolves the person's live permissions at each mint, never from the consent —
  `packages/iam/src/oauth.ts:222-243`. No token says an agent holds it.
- ✔ Control's GitHub App identity check accepts the `push` event only —
  `packages/control/src/github/connections/port.ts:135`, `configuration.ts:88`, `:97`; the connection DTO hard-codes
  `events: ['push']` — `connections/status.ts:140` (detail in
  [the access diff spec](../specs/access-diff-as-a-github-check.md#rollout-on-an-existing-installation)).
- ⚠ The approval's readable lines come from `packages/control/src/approval/diff.ts`, not `human.ts` (which holds the
  human-approver rule).
- ⚠ Control has no rollback verb: the only redeploy is inside a side restore, and it passes the run's recorded ref, a
  branch for a pushed run (`redeployable`, `packages/control/src/data-operations.ts:433`); a `backup` data operation
  answers 501 — `packages/control/src/control-rpc.ts:797`.
- ✔ The Zerops proxy runs stock Caddy 2.10.2, with no response-body rewrite —
  `packages/provider-zerops/src/installation/topology/setups.ts:413`.
- ✔ The proxy sets `Cross-Origin-Opener-Policy: same-origin` on every application answer —
  `packages/proxy-core/src/headers.ts:136`.
- ✔ MCP authoring and its dev sandboxes are Zerops only —
  [ADR-0049](../decisions/0049-author-applications-through-mcp-in-control.md) rule 9.

## Work units

Each WU is one spec. Its PR slices, witnesses and touch points are in the spec; a WU is done when every slice this
sprint schedules is merged and its reference and ADR changes are in.

### WU0 — Verify first (S)

- **Problem.** Several specs rest on a fact no test has checked, and two of them decide what gets built.
- **Scope.** One check per spec, each answered in this sprint's run log before its WU starts:
  - WU2: whether Claude's and ChatGPT's connectors receive IAM's default scopes or request only `authoring` (decides
    whether the new `operations` scope reaches them without a client change).
  - WU3: that GitHub serves a fork head's archive through the base repository by commit SHA.
  - WU4: whether a run can record the applied migration ledger of every bundle on each provider; where it cannot
    (Zerops today), the rollback verdict is `migrations_unknown`.
  - WU5: that `Authorizer.authorize` runs unchanged against an in-memory IAM double, over the entry the provider
    actually publishes.
  - WU6: that `caddyserver/replace-response` streams a `text/html` answer, gzip upstream included, limited to one host's
    navigations, in a Caddy 2.10.2 built as the Zerops proxy is. **This picks WU6's path**: Zerops first if it passes,
    Cloudflare only otherwise. And that the ticket hand-over through `BroadcastChannel` works under the proxy's COOP in
    Chromium and Firefox.
- **Not here, and why.** WU1's check (Control's capability report against each provider's upgrade order) and WU7's
  (a namespace proxy answers 404 for a removed member's host) concern only task keys slices 2–5 and retire, which wait
  ("Later"); they run when those are planned.
- **Acceptance / witness.** A run-log line per check with its result and, for WU6, the chosen order.

### WU1 — Agent task keys, slice 1 (S)

- **Problem.** An agent acting for a person holds the person's own grant; audit, commits and the console cannot tell the
  agent from the person, and nothing bounds a task.
- **Scope.** [Spec](../specs/agent-task-keys.md), slice 1 only: the `act` claim in `auth-core` (builders, the parser
  that accepts it only beside OAuth claims and refuses it malformed), `AuthContext.actor`, and Operations' redaction of
  `pt_` secrets. Inactive: nothing mints `act`. Slices 2–5 (Control enforcement, IAM tasks and exchange, audit, the
  console panel) wait until a follow-up that needs a task key is planned.
- **Acceptance / witness.** The claim tests (`token.test.ts`, `resource-token.test.ts`) and the `pt_` cases of
  `packages/operations/src/__tests__/ingest.test.ts`.

### WU2 — Operations tools in the authoring MCP (S–M)

- **Problem.** The authoring agent sees its build and dev sandbox but not what fails after the build is served.
- **Scope.** [Spec](../specs/operations-tools-in-the-authoring-mcp.md), slices 1–3: Operations accepts the MCP resource
  token under a new `operations` scope; `list_issues`, `get_issue`, `get_health` on an unprotected authoring
  environment and dev only (Control refuses `authoring` with `protected`); `update_issue` and the workspace's new and
  regressed stage issues, left out for a token without the scope. ADR-0049 rewritten in place.
- **Acceptance / witness.** The `mcp.test.ts` cases of the spec: a production environment is refused, end-user strings
  and issue comments come back under `untrusted`, `rawEvent` never leaves Operations.

### WU3 — Access diff as a GitHub check (S–M)

- **Problem.** A reviewer reads a pull request that widens access without seeing it; the diff shows only at deploy
  approval in the console.
- **Scope.** [Spec](../specs/access-diff-as-a-github-check.md), slices 1–5: accept the wider App (`checks: write`,
  `pull_request` events, the connection DTO reporting the verified events) with a per-connection opt-out, the check
  job, re-run and acceptance, the console page, the refresh after publication. ADR-0029 rewritten in place.
- **Acceptance / witness.** A pull request that widens a role gets a `neutral` check naming the widening; one that
  changes no access gets `success`; an App not yet re-approved gets no check and the console says why.

### WU4 — Release watch window and manual rollback (M)

- **Problem.** Nobody watches a release after it ships, and a rollback is a manual redeploy whose safety the operator
  works out alone.
- **Scope.** [Spec](../specs/release-watch-window-and-rollback.md), slices 1–5: watch windows anchored to the run's
  finish time, with an observed verdict (health checks Operations runs itself) and a reported verdict (ingested errors,
  which anyone holding the DSN can forge), in Operations; the `suspect_release` alert; the rollback verdict and
  `runs.rollback` in Control, started by a person; the MCP and fleet read-outs; docs. The automatic rollback is
  [backlog 273](../backlog/273-automatic-rollback-of-a-suspect-release.md), with its own ADR.
- **Acceptance / witness.** The scoring table tests; a rollback across a migration is offered with the migration list
  and a `migrated` verdict; forged browser errors leave the observed verdict `clean`; a replayed projection opens no
  second window; a rollback run records `rollback_of` and deploys the target's exact commit.

### WU5 — Access simulator (M)

- **Problem.** "Why can this person not reach this page" has no answer in the console, and an agent that meets a 403
  tends to loosen the contract.
- **Scope.** [Spec](../specs/access-simulator.md), slices 1–5: `@fabrika/proxy-core/simulate`, role-based answers in the
  console and as `explain_access` (scope `authoring`), real principals through IAM `access.preview`, a refused-request
  reference, people counts on the approval page for an approver who is also an IAM administrator, through their own
  token. ADR-0022 §3 and ADR-0050 §7 gain a paragraph each.
- **Acceptance / witness.** Every application case of the proxy's endpoint and deny matrices gives the same result
  through the real decision and through the simulator; an approver without `iam.admin` sees no counts and Control
  makes no IAM call for them.

### WU6 — Review widget on stage and dev (M, plus S–M per provider)

- **Problem.** Stakeholders report on a stage application in chat with screenshots; the agent never sees a page,
  element or commit.
- **Scope.** [Spec](../specs/review-widget-on-stage-and-dev.md), slices 1–4 in the order WU0 picked: threads, short
  tickets, the `review` scope and MCP tools in Control; the widget with its CSP and Caddy injection on Zerops; the
  `HTMLRewriter` injection on Cloudflare; an opice suite. If WU0's Caddy check fails, slices 2 and 3 swap and Zerops
  gets no widget. Reviewers are internal people in v1. New ADR: review threads live in Control, and the proxy may
  rewrite HTML for presentation only.
- **Acceptance / witness.** The Caddy live matrix (or the proxy Worker matrix): a stage HTML answer carries the script
  tag, a protected environment's or `prod`'s never does; the ticket reaches the widget under COOP; a comment made
  after a later deploy keeps the run that served the page where the proxy knows it; the MCP witness creates and
  answers a thread.

### WU7 — Fleet overview, the view (M)

- **Problem.** Nobody can say in one place who owns an application, whether anyone uses it, or how far its framework
  lags.
- **Scope.** [Spec](../specs/fleet-overview.md), slices 1–4: the owner field, `fleet.list` with the framework column
  (backlog 190 deleted), IAM sign-in aggregates and Operations summaries, the `/fleet` page. Retire, restore and the
  delete after retention (slices 5–6) wait ("Later").
- **Acceptance / witness.** The fleet read flags a lagging framework, an unknown one and an idle environment from
  fixtures; each plane's `forbidden` and `unavailable` state renders without hiding the others.

## Out of scope (explicit)

Filed as backlog, each with its dependencies:
[266](../backlog/266-fleet-wide-framework-upgrades.md) fleet-wide framework upgrades (after WU3 and WU7),
[267](../backlog/267-every-application-as-an-mcp-server.md) every application as an MCP server (an ADR on data reaching
external models first), [268](../backlog/268-opice-journeys-as-a-stage-gate-and-production-checks.md) opice journeys as
a stage gate and production checks, [269](../backlog/269-masked-production-data-for-dev-and-stage.md) masked production
data, [270](../backlog/270-a-self-healing-loop.md) the self-healing loop (after WU2, WU4 and task keys slices 2–5),
[271](../backlog/271-fast-dev-sandboxes-on-cloudflare.md) fast dev sandboxes on Cloudflare,
[272](../backlog/272-authoring-workspaces-on-kompjutr.md) authoring workspaces on kompjutr,
[273](../backlog/273-automatic-rollback-of-a-suspect-release.md) automatic rollback of a suspect release.

Also out: production events through MCP (WU2 reads stage and dev only), approving access from the pull request (WU3),
people counts on the GitHub check (WU5: no person's token there), cost per application (WU7).

## Decisions

Decided at the review of 2026-11-04:

1. **Task keys: slice 1 only** (WU1). The `act` claim lands as an inactive foundation; slices 2–5 wait until the
   follow-ups that need them are planned.
2. **Review widget: Zerops first if Caddy can do it** (WU6). WU0 checks the `replace-response` module; if it passes,
   the Zerops path is built before the Cloudflare one.
3. **Automatic rollback goes to the backlog** (WU4). This sprint ships the warning in the watch window and a manual
   rollback; the automatic rollback comes later with its own ADR ([273](../backlog/273-automatic-rollback-of-a-suspect-release.md)).
4. **Fleet: the overview now, retiring later** (WU7). Slices 1–4 now; retire and restore later.
5. **People counts only for an IAM administrator** (WU5). Shown only to an approver who is also an IAM administrator,
   through their own token; Control gets no new IAM credential.
6. **Sprint order by dependencies** ("Sequencing").

The specs' own defaults, which the WUs build on:

7. **MCP reads no production events** (WU2). A per-installation switch comes with 269/270, not before.
8. **One scope per feature; `authoring` is not widened** (WU2, WU6). Operations tools get an `operations` scope and
   review tools a `review` scope, because IAM resolves a scope's grants at each refresh and existing consents would
   gain Operations access silently. Every `/mcp` token still carries `authoring`, which the `/mcp` row requires.
9. **A task key is an OAuth grant kind, not a `px_` key** (WU1, later slices). Its token is the same resource token MCP
   uses, so the proxy, the console table and Control's `/mcp` gate do not change.
10. **The access check informs, it does not gate** (WU3). A widening is `neutral`; approval stays in the console
    (ADR-0050 §5 unchanged).
11. **Review threads live in Control** (WU6), not in the share worker; the widget never appears on a protected
    environment.

## Sequencing

| Wave  | Runs in parallel                                                                                      | Why here                                                                                                                                          |
| ----- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | WU0                                                                                                   | The checks decide what WU2, WU3, WU4 and WU5 rest on, and WU6's path                                                                              |
| 1     | WU2 slices 1–3 · WU3 slice 1 (wider App) · WU4 slice 1 · WU1 slice 1                                  | The agent's view of errors; the GitHub permission change operators must re-approve ahead of time; the windows; the identity agents will act under |
| 2     | WU3 slices 2–5 · WU5 slices 1–3 · WU4 slices 2–3 · WU7 slices 1–4                                     | The check runs once the Apps are re-approved; the alert follows the windows; the simulator and the fleet view stand on existing code              |
| 3     | WU6 slices 1–4 (order from WU0) · WU5 slices 4–5 · WU4 slices 4–5                                     | People counts need simulator slices 1–3; WU4's read-outs need WU2 and the fleet page (WU7 slice 4)                                                |
| Later | Backlog 273 (automatic rollback) · WU7 slices 5–6 (retire; 6 blocked by backlog 203) · WU1 slices 2–5 | Decided to wait; each starts when it is planned                                                                                                   |

Where the order differs from the plan the review proposed, the specs' dependencies decided it:

- **WU4 slices 4–5 move to wave 3.** Slice 4 puts the verdict on the fleet page and in the MCP tools, so it follows
  WU7 slice 4 (wave 2); the docs slice closes the WU after it. The proposed "watch window 2–4" counted the automatic
  rollback, which is now backlog 273, so wave 2 keeps slices 2–3 (the alert and the manual rollback).
- **WU5 slice 4 (refused-request reference) joins wave 3.** The proposed plan did not place it; its console replay
  needs slices 2 and 3. Its proxy half needs nothing and may land earlier.
- **WU0 leaves out WU1's and WU7's checks**, which concern only the slices that wait.
- **WU6 runs without task keys.** An agent's reply records the MCP principal; it carries `act` only once WU1 slices
  2–5 ship.

## Run log

- 2026-11-02 — Planned from a feature-ideas review. Seven specs written; implementation waits for their review.
- 2026-11-04 — Review applied: twelve corrections to the specs, the open questions decided, the waves reordered by
  dependencies. Backlog items renumbered 266–272 after a numbering clash on rebase; automatic rollback filed as 273.
