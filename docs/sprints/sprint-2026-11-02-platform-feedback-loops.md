# Sprint — platform feedback loops (2026-11-02)

**Goal.** The platform tells the people and agents who change an application what their change did: whether it widens
access, what breaks after it ships, what a reviewer said about it, and who acted when an agent did.

**Theme.** Seven features, each designed in its own [spec](../specs/README.md). They share one shape: data the platform
already holds (approved access, Operations issues, IAM grants, the registry) reaches the person or agent at the moment a
decision is made, through surfaces that exist (the console, the GitHub App, the authoring MCP, the proxy). None adds a
service. The batch succeeds when an agent can deploy a workspace, read the errors of that deploy, read a reviewer's
comments on it and answer them under its own task identity, and a person can see on the pull request and in the console
what the change widened and whether its release is safe to roll back.

Implementation starts after the specs are reviewed. Each spec's open questions carry a recommended default; a WU starts
on the defaults unless a review answer changes them.

## Refs re-verified at HEAD (2026-11-02, `e06eac287`)

Each spec carries its own citations; these are the facts the order depends on.

- ✔ The authoring MCP has 18 tools and no Operations tool — `packages/control/src/mcp/handler.ts:217-411`.
- ✔ The `authoring` scope grants five Control actions and no `operations.*` action —
  `packages/platform-artifacts/src/proxy-manifest.ts:59-72`.
- ✔ Operations verifies only the console's own tokens (app `vozka`) — `packages/operations/src/auth.ts:23`.
- ✔ An OAuth grant resolves the person's live permissions at each mint, never from the consent —
  `packages/iam/src/oauth.ts:220-226`. No token says an agent holds it.
- ✔ Control's GitHub App identity check accepts the `push` event only — `packages/provider-zerops/src/source/port.ts`
  (detail in [the access diff spec](../specs/access-diff-as-a-github-check.md#rollout-on-an-existing-installation)).
- ⚠ The approval's readable lines come from `packages/control/src/approval/diff.ts`, not `human.ts` (which holds the
  human-approver rule).
- ⚠ Control has no rollback verb: the only redeploy is inside a side restore
  (`packages/control/src/data-operations.ts`), and a `backup` data operation answers 501 —
  `packages/control/src/control-rpc.ts:798`.
- ✔ The Zerops proxy runs stock Caddy 2.10.2, with no response-body rewrite —
  `packages/provider-zerops/src/installation/topology/setups.ts`.
- ✔ MCP authoring and its dev sandboxes are Zerops only —
  [ADR-0049](../decisions/0049-author-applications-through-mcp-in-control.md) rule 9.

## Work units

Each WU is one spec. Its PR slices, witnesses and touch points are in the spec; a WU is done when every slice is merged
and its reference and ADR changes are in.

### WU1 — Agent task keys (M)

- **Problem.** An agent acting for a person holds the person's own grant; audit, commits and the console cannot tell the
  agent from the person, and nothing bounds a task.
- **Verify first.** `parseAccessClaims` ignores unknown claims, so an older Control reads a task token as the person's,
  and Zerops upgrades IAM before Control. The spec gates issuance and exchange on Control's capability report; confirm
  the report's timing on both providers' upgrade order.
- **Scope.** [Spec](../specs/agent-task-keys.md), slices 1–5: the `act` claim, Control enforcement (target, path
  globs, budgets, the frozen environment), IAM tasks and the token exchange, audit attribution, the console panel. A task
  carries the scopes its form picks (`authoring`, `operations`, `review`). New ADR: an agent acts for a
  person through a task key.
- **Acceptance / witness.** A task token exchanged from a `pt_` key reaches `/mcp`, its commits carry the task
  trailers, its audit rows name both the person and the agent, a spent budget refuses the next deploy, and a revoked
  task's next exchange fails; a new IAM beside an old Control issues no task.

### WU2 — Operations tools in the authoring MCP (S–M)

- **Problem.** The authoring agent sees its build and dev sandbox but not what fails after the build is served.
- **Verify first.** Whether Claude's and ChatGPT's connectors receive IAM's default scopes or request only
  `authoring` (decides whether the new `operations` scope reaches them without a client change).
- **Scope.** [Spec](../specs/operations-tools-in-the-authoring-mcp.md), slices 1–3: Operations accepts the MCP resource
  token under a new `operations` scope; `list_issues`, `get_issue`, `get_health` on an unprotected authoring
  environment and dev only (Control refuses `authoring` with `protected`); `update_issue` and the workspace's new and
  regressed stage issues. ADR-0049 rewritten in place.
- **Acceptance / witness.** The `mcp.test.ts` cases of the spec: a production environment is refused, end-user strings
  come back under `untrusted`, `rawEvent` never leaves Operations.

### WU3 — Access diff as a GitHub check (S–M)

- **Problem.** A reviewer reads a pull request that widens access without seeing it; the diff shows only at deploy
  approval in the console.
- **Verify first.** That GitHub serves a fork head's archive through the base repository by commit SHA.
- **Scope.** [Spec](../specs/access-diff-as-a-github-check.md), slices 1–5: accept the wider App (`checks: write`,
  `pull_request` events) with a per-connection opt-out, the check job, re-run and acceptance, the console page, the
  refresh after publication. ADR-0029 rewritten in place.
- **Acceptance / witness.** A pull request that widens a role gets a `neutral` check naming the widening; one that
  changes no access gets `success`; an App not yet re-approved gets no check and the console says why.

### WU4 — Release watch window and rollback (M)

- **Problem.** Nobody watches a release after it ships, and a rollback is a manual redeploy whose safety the operator
  works out alone.
- **Verify first.** Whether a run can record the applied migration ledger of every bundle on each provider; where it
  cannot (Zerops today), the verdict is `migrations_unknown` and nothing rolls back automatically.
- **Scope.** [Spec](../specs/release-watch-window-and-rollback.md), slices 1–6: watch windows anchored to the run's
  finish time, with an observed verdict (health checks Operations runs itself; the only one that may roll back
  automatically) and a reported verdict (ingested errors, which anyone holding the DSN can forge; alerts only), in
  Operations, the `suspect_release` alert, the rollback verdict and `runs.rollback` in Control, opt-in automatic
  rollback, the MCP and fleet read-outs, docs. New ADR: a suspect release rolls back only when nothing migrated or
  widened between.
- **Acceptance / witness.** The scoring table tests; a rollback across a migration is refused automatically and offered
  manually with the migration list; forged browser errors never start an automatic rollback; a replayed projection opens no
  second window; a rollback run records `rollback_of`.

### WU5 — Access simulator (M)

- **Problem.** "Why can this person not reach this page" has no answer in the console, and an agent that meets a 403
  tends to loosen the contract.
- **Verify first.** That `Authorizer.authorize` runs unchanged against an in-memory IAM double (the simulator must call
  the decision, never restate it), over the entry the provider actually publishes.
- **Scope.** [Spec](../specs/access-simulator.md), slices 1–5: `@fabrika/proxy-core/simulate`, role-based answers in the
  console and as `explain_access`, real principals through IAM `access.preview`, a refused-request reference, people
  counts on the approval page. ADR-0022 §3 and ADR-0050 §7 gain a paragraph each.
- **Acceptance / witness.** Every application case of the proxy's endpoint and deny matrices gives the same result
  through the real decision and through the simulator.

### WU6 — Review widget on stage and dev (M, plus M for Zerops)

- **Problem.** Stakeholders report on a stage application in chat with screenshots; the agent never sees a page,
  element or commit.
- **Verify first.** That `window.opener` survives the proxy's COOP header for the sign-in popup, or that the fragment
  redirect works instead; and that a Caddy response-rewrite module streams gzip answers.
- **Scope.** [Spec](../specs/review-widget-on-stage-and-dev.md), slices 1–4: threads, short tickets, the `review` scope
  and MCP tools in Control; the widget with its CSP and `HTMLRewriter` injection on Cloudflare; Caddy injection on Zerops;
  an opice suite. Reviewers are internal people in v1. New ADR: review threads live in Control, and the proxy may rewrite HTML for presentation only.
- **Acceptance / witness.** The proxy Worker matrix: a stage HTML answer carries the script tag, a protected
  environment's or `prod`'s never does; a comment made after a later deploy keeps the run that served the page; the MCP
  witness creates and answers a thread.

### WU7 — Fleet overview (M + M)

- **Problem.** Nobody can say in one place who owns an application, whether anyone uses it, or how far its framework
  lags.
- **Verify first.** That a namespace proxy answers 404 for a removed member's host (retire on Zerops relies on it).
- **Scope.** [Spec](../specs/fleet-overview.md), slices 1–6: the owner field, `fleet.list` with the framework column
  (backlog 190 deleted), IAM sign-in aggregates and Operations summaries, the `/fleet` page, retire and restore, delete
  after retention (blocked by [backlog 203](../backlog/203-deleting-an-app-or-env-leaves-its-secrets-and-iam-keys.md)
  items 1–2). New ADR: an application environment is retired before it is deleted.
- **Acceptance / witness.** The fleet read flags a lagging framework and an idle environment from fixtures; retire on
  both providers backs up (or records an explicit "no backup" on Zerops), stops serving, revokes keys and deletes their
  records, refuses any credential but a person's; restore deploys with fresh keys and undoes
  it.

## Out of scope (explicit)

Filed as backlog in the same change, each with its dependencies:
[266](../backlog/266-fleet-wide-framework-upgrades.md) fleet-wide framework upgrades (after WU3 and WU7),
[267](../backlog/267-every-application-as-an-mcp-server.md) every application as an MCP server (an ADR on data reaching
external models first), [268](../backlog/268-opice-journeys-as-a-stage-gate-and-production-checks.md) opice journeys as
a stage gate and production checks, [269](../backlog/269-masked-production-data-for-dev-and-stage.md) masked production
data, [270](../backlog/270-a-self-healing-loop.md) the self-healing loop (after WU1, WU2 and WU4),
[271](../backlog/271-fast-dev-sandboxes-on-cloudflare.md) fast dev sandboxes on Cloudflare,
[272](../backlog/272-authoring-workspaces-on-kompjutr.md) authoring workspaces on kompjutr.

Also out: production events through MCP (WU2 reads stage and dev only), approving access from the pull request (WU3),
cost per application (WU7), stopping Zerops services on retire (WU7).

## Decisions

The defaults each spec recommends, which the WUs build on unless the review changes them:

1. **MCP reads no production events** (WU2). A per-installation switch comes with 269/270, not before.
2. **One scope per feature; `authoring` is not widened** (WU1, WU2, WU6). Operations tools get an `operations` scope and
   review tools a `review` scope, and a task key picks which scopes it carries, because IAM resolves a
   scope's grants at each refresh and existing consents would gain Operations access silently.
3. **A task key is an OAuth grant kind, not a `px_` key** (WU1). Its token is the same resource token MCP uses, so the
   proxy, the console table and Control's `/mcp` gate do not change. Issued only by a signed-in person, at most 24 h.
4. **The access check informs, it does not gate** (WU3). A widening is `neutral`; approval stays in the console
   (ADR-0050 §5 unchanged).
5. **Automatic rollback is opt-in per environment and only a person can switch it on** (WU4); it never crosses a
   migration or an access widening.
6. **Review threads live in Control** (WU6), not in the share worker; the widget never appears on a protected
   environment.
7. **Retire keeps a retired environment 30 days; a person deletes it** (WU7).

## Sequencing

Agent-facing features build on WU1's `act` claim, so it lands first. The rest is ordered by what each reads.

| Wave | Runs in parallel                                                                   | Why first                                                                                                                          |
| ---- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 1    | WU1 slice 1 (`act` claim) · WU2 slices 1–3 · WU3 slice 1 (wider App) · WU5 slice 1 | Foundations: the identity agents act under, the agent's view of errors, the GitHub permission change existing Apps must re-approve |
| 2    | WU1 slices 2–5 · WU3 slices 2–5 · WU4 slices 1–4 · WU5 slices 2–5                  | Task keys complete before anything runs unattended; the watch window needs only Operations and the approval diff                   |
| 3    | WU6 slices 1–4 · WU7 slices 1–5 · WU4 slices 5–6                                   | The widget's agent replies carry `act`; WU4 slice 5 adds the verdict as a fleet column; WU4's read-outs need WU2 and WU7           |
| —    | WU7 slice 6                                                                        | Waits for backlog 203 items 1–2                                                                                                    |

WU3 slice 1 lands early on purpose: every installation's operator must re-approve the GitHub App before the check runs,
and Control must accept the wider App before anyone edits it (an App with `pull_request` events fails Control's identity
check today).

## Run log

- 2026-11-02 — Planned from a feature-ideas review. Seven specs written; implementation waits for their review.
