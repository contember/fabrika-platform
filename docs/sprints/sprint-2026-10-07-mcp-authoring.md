# Sprint — MCP application authoring on Zerops (2026-10-07)

**Goal.** An employee uses their own Claude or ChatGPT account through MCP to edit an application,
deploy it to a stage environment, open a pull request, and reach production through the ordinary
merge-and-deploy path.

**Theme.** Rebuild the working core of the `mcp-spike` branch on a fresh branch from `main`. Port the
Git-first slice (ADR-0057 on the spike branch). Leave the earlier hosted-builder design (ADR-0049 to
ADR-0056 on the spike branch) behind. Success is one real flow from a Claude connector to a running
stage and production deployment on Zerops, not component test counts.

## Refs re-verified at HEAD (2026-10-07)

- ✔ A manual run accepts an explicit ref and an optional pinned commit — `packages/control/src/db/runs.ts:106`.
- ✔ Zerops deploy honours a pinned commit through the in-process source resolve — `packages/control/src/run-lifecycle.ts`.
- ✔ Control holds each GitHub connection's App key in its vault (ADR-0029) — `packages/control/src/github/connections/credentials.ts`.
- ✔ The proxy reads the console gates from `CONTROL_PROXY_GATES` — `packages/control/fabrika.gates.ts`.
- ⚠ `main` has no OAuth server, no resource-token profile and no repository write client; all three are ported.

## Target flow

1. The user adds the Fabrika MCP server to Claude or ChatGPT and logs in through IAM (OAuth).
2. `list_targets` shows the app/stage environments that the user may author.
3. `create_workspace` creates a working branch from the default branch.
4. `list_files`, `read_files`, `apply_changes` read the branch and create ordinary commits.
5. `deploy_stage` deploys the workspace head to the stage environment through an ordinary Control run.
6. `get_deployment` and `get_logs` report the run status, the deployed SHA and the build logs.
7. `create_pull_request` opens a normal GitHub PR to the default branch.
8. A human reviews and merges in GitHub. The existing Delivery trigger deploys production.

## What we keep from the `mcp-spike` branch (port, then trim)

| Spike source                                                                                                   | Lines | Purpose                                                                |
| -------------------------------------------------------------------------------------------------------------- | ----- | ---------------------------------------------------------------------- |
| `packages/github-app/src/repository*.ts`                                                                       | ~1.1k | Branch create, tree read, batched commit with expected head, PR create |
| `packages/source-zerops/src/workspace-{kernel,client,http}.ts`                                                 | ~630  | Source owns GitHub credentials and performs the writes                 |
| `packages/control-contract/src/git-workspace.ts`                                                               | ~630  | Wire contract; trim to the tools below                                 |
| `packages/control/src/api/git-workspaces.ts`, `db/git-workspaces.ts`, migration `0026/0030_git_workspaces.sql` | ~570  | Workspaces, operation receipts, stage run creation                     |
| `packages/iam/src/oauth*.ts`, `repositories/oauth.ts`                                                          | ~1.2k | Authorization code + PKCE, CIMD for Claude/ChatGPT, refresh, consent   |
| `packages/builder-hosted-spike/src/git-first/handler.ts`                                                       | ~200  | MCP tool definitions                                                   |
| `examples/git-first-app`                                                                                       | ~800  | Bun/Postgres template with `zerops.yaml`                               |

Estimated result: 5–7k lines including tests. The spike branch adds 144k lines over `main`.

## What we drop

- `packages/data-core`, `data-contract`: platform-owned data language, SQL AST, outbox.
- `packages/provider-execution-{docker,swarmvm,cloudflare}`: sandboxed CHECK of generated code.
- `builder-hosted-spike` outside `git-first/`: trusted compiler, generated runtime, artifact compilers.
- Control runtime placement/allocation/selection, `delivery-workflow` policy engine, revision provisioning.
- Source trusted-startup archives and manifests, Cloudflare hosted role graphs and probe routers.
- IAM data authority, delegation and delegation refresh (only if D1 below picks "MCP in Control").
- The separate Builder service and its Postgres delegation journal (same condition).

## Decisions

Recorded in [ADR-0049](../decisions/0049-author-applications-through-mcp-in-control.md):
MCP in Control (no delegation), one stage environment per app, `app_envs.authoring` marks a target,
`zerops.yaml` and `fabrika.*` are protected, production through merge and Delivery. Workspace
operations carry no receipts: a commit names its expected head, and a repeated PR request returns the
open PR. The MCP SDK (`@modelcontextprotocol/server`) is an approved new dependency of Control.

## Work units

### WU0 — Branch and ADR (S)

- **Scope.** New branch from `main`. One ADR "Author applications through MCP and Git workspaces"
  that records D1–D5. Do not port ADR-0049 to ADR-0057.
- **Acceptance.** ADR reviewed by the user.

### WU1 — GitHub repository writes (M)

- **Verify first.** What `main`'s `github-app` already offers for reads and installation tokens.
- **Scope.** Port branch creation, tree listing, bounded file read, batched commit with expected head
  (stale head fails, no force update), PR creation.
- **Acceptance.** Tests against a recorded GitHub API fixture: commit on a stale head fails;
  a commit creates exactly one new commit on the working branch; PR creation is idempotent per request key.
- **Touch points.** `packages/github-app/src/`.

### WU2 — Workspace operations through the connection's GitHub App (M)

- **Verify first.** The GitHub App needs `contents: write` and `pull_requests: write`.
- **Scope.** Execute workspace operations in Control through the binding's own GitHub App, the key read
  from the vault per operation. (Planned in the Zerops Source service; `main` folded Source into Control.)
- **Acceptance.** Tests with a fake App client: the bound connection's key opens the repository, a
  foreign owner is refused before any client exists, GitHub refusals are classified without their text.
- **Touch points.** `packages/control/src/github/workspace.ts`.

### WU3 — Control workspaces and stage deploy (M)

- **Scope.** Migration (SQLite + Postgres), repository, use cases: create, list, get, list/read
  files, edit, deploy stage, PR, operation status, logs. Idempotent operation IDs with receipts.
  Stage deploy creates an ordinary run on the working ref and exact SHA and enqueues it.
  Enforce D3 and D4 here.
- **Acceptance.** Control tests on both SQLite and Postgres (`FABRIKA_TEST_POSTGRES_URL`): a user
  without grants sees nothing; a stage deploy creates exactly one run for the requested SHA; a retry
  with the same operation ID does not create a second run.
- **Touch points.** `packages/control/src/api/`, `db/`, `migrations*/`, `control-contract`.

### WU4 — IAM OAuth for MCP clients (M)

- **Verify first.** Current Claude and ChatGPT connector requirements: protected resource metadata,
  CIMD versus dynamic client registration, PKCE S256, refresh tokens.
- **Scope.** Port authorization code + PKCE, consent page, CIMD for configured Claude/ChatGPT
  metadata URLs, refresh rotation, revocation. Leave out delegation (if D1 = Control).
- **Acceptance.** Tests for code replay, refresh reuse, wrong resource, unregistered client.
  A real Claude connector completes login against the local stack.
- **Touch points.** `packages/iam/src/oauth*.ts`, `repositories/oauth.ts`, `iam-ui` consent.

### WU5 — MCP endpoint (S)

- **Verify first.** Adding `@modelcontextprotocol/server` to Control is a new dependency; confirm.
- **Scope.** The eight tools from the target flow, each calling the WU3 use case. Proxy gate: `/mcp`
  requires an OAuth bearer, the protected resource metadata is public.
- **Acceptance.** Protocol test: tool list, one call per tool, unauthorized call refused.
- **Touch points.** `packages/control/src/mcp/`, proxy gate declaration.

### WU6 — App template (S)

- **Scope.** Port `examples/git-first-app`: Bun, Postgres, migrations, `/healthz`, injected identity.
  Add a short `AGENTS.md` in the template that tells the model the rules (protected files, how to
  read the identity, how to add a migration).
- **Acceptance.** The template deploys to the local-stack Zerops emulator and to a real Zerops project.

### WU7 — End-to-end witness (M)

- **Scope.** One automated test on the local stack that drives the MCP tools through the whole flow.
  One manual run from a real Claude account against a real Zerops stage.
- **Acceptance.** The stage URL serves the new commit, the reported SHA matches, the PR exists, a merge
  deploys production. Record the run in the sprint log.

## Out of scope

- Cloudflare target.
- Isolation of generated code from app data; the app owns its data and authorization (ADR-0022 still holds).
- Sandboxed checks before deploy; Zerops build is the check.
- Per-workspace preview environments, data reset, merge or production deploy through MCP.
- Delivery policy engine (approvals, PR-only policies).

## Sequencing

| Step | Work          | Parallel               |
| ---- | ------------- | ---------------------- |
| 1    | WU0           | —                      |
| 2    | WU1, WU4, WU6 | yes, disjoint packages |
| 3    | WU2           | after WU1              |
| 4    | WU3           | after WU2              |
| 5    | WU5           | after WU3 and WU4      |
| 6    | WU7           | last                   |

## Run log

- 2026-10-07 — All work units landed, each after an independent review and its fix round: contracts,
  GitHub client, Source workspace route, proxy/SDK, IAM OAuth, Control MCP + one authoring env per
  app, installation/local stack, in-process witness, builder fixture. Full `bun run test`: 4,512 + 323 + 180 pass, 0 fail (293 skipped: suites needing Postgres/S3 env). WU6 (template) needed no new code: `examples/zerops-app` is already the
  ordinary Bun/Postgres app.
- Review-driven changes beyond the plan: IAM's native verifier refuses resource tokens;
  `get_deployment` is owner-scoped; `deploy_stage` always deploys the live head; all of `.github/`
  is protected; one authoring environment per app; platform hosts are lowercased.
- Known limits: an issued access token stays valid ≤ 300 s after revocation; a concurrent reset of a
  workspace branch to an ancestor can still be fast-forwarded (REST has no compare-and-swap); two
  concurrent `authoring: true` puts on different envs can race; existing sidecars need a hand edit to
  pass `FABRIKA_PLATFORM_MCP_CLIENTS_JSON`; the App identity DTOs still state `contents: read`.
- Open acceptance (needs an operator): a real Claude/ChatGPT connector against a real installation,
  a real GitHub App with write permissions, and a real Zerops stage build of a workspace commit.
  The in-process witness does not run Caddy, a Zerops build, GitHub or a real client.
- 2026-10-08 — Rebased onto the second simplification pass. Source is gone from `main`, so the Source
  workspace route and its wire protocol were dropped; Control runs workspace operations itself
  (`src/github/workspace.ts`) and repository paths are checked at the MCP boundary (`isRepositoryPath`).
  The proxy OAuth contract moved into `@fabrika/proxy-core/manifest`, the installation into
  `provider-zerops/src/installation`, and the migrations follow the squashed baselines (`0002_*`).
