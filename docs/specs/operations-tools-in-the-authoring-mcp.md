# Operations tools in the authoring MCP

**Summary.** The MCP authoring agent reads the errors and health of the environments it deploys, and comments on or
resolves an issue it fixed, through Operations' own RPC and authorization. Size: S–M.

- **Depends on:** nothing unbuilt. Builds on [ADR-0049](../decisions/0049-author-applications-through-mcp-in-control.md)
  (MCP authoring) and [ADR-0016](../decisions/0016-independent-operations-plane.md) (Operations owns its authorization).
- **Enables:** [release watch window](./release-watch-window-and-rollback.md) (the agent reads a release's verdict),
  [agent task keys](./agent-task-keys.md) (a task key reaches the same tools), and the self-healing loop
  ([backlog 270](../backlog/270-a-self-healing-loop.md)).

## Problem

An agent authoring through MCP sees its build (`get_deployment`) and its dev sandbox (`get_dev_status`, `run_checks`),
but not what fails after the build is served. A stage request that throws becomes an Operations issue, and the person
driving the agent copies its stack trace from the console into the chat. The MCP tool list
(`packages/control/src/mcp/handler.ts:217-411`, [`reference/mcp-authoring.md`](../reference/mcp-authoring.md#tools))
has no Operations tool.

Everything the agent needs already exists behind `OperationsRpcContract`: issue lists and detail with source-mapped
frames, occurrences, releases by run and commit, HTTP checks and telemetry health
(`packages/operations/src/operator-rpc.ts:16-79`). What is missing is a path from an MCP token to that contract.

## Design

### The path from an MCP call to Operations

Today a console request reaches Operations like this: the console proxy admits a session on the `operations-rpc` row
(`packages/control/fabrika.service.ts:56`, callers `human`, `machine`), injects a token of the console app (`vozka`),
and Control's gateway forwards the request with that token to Operations' private `POST /api/rpc`
(`packages/control/src/operations-gateway.ts:16-39`). Operations verifies the token as a native `vozka` token
(`packages/operations/src/auth.ts:23-27`) and authorizes each use case against `operations.read` / `operations.triage`
at the source's `app` or `environment` scope (`packages/operations/src/access.ts:17-36`).

An MCP call carries a different token: an `at+jwt` resource token for `https://<console>/mcp`, also of app `vozka`
(`packages/control/src/bun/mcp.ts:27-29`, `CONTROL_APP_ID` in `packages/control-contract/src/access.ts:4`). Operations'
verifier refuses it today, because a native verifier refuses a resource token (IAM's `verifyAccessToken` rule).

The design keeps Operations the owner of authorization and adds no second credential:

1. **Control forwards the caller's own resource token.** Each new MCP tool calls Operations' RPC with
   `createRpcClient<OperationsRpcContract>` (`@fabrika/app`, as `packages/dashboard/src/lib/api.ts` does) over
   Control's `OPERATIONS` service (`packages/control/src/env.ts:63`), with the injected token the proxy gave the `/mcp`
   request. Control makes no authorization decision for Operations data beyond the target filter below.
2. **Operations accepts the console's MCP resource token on its private RPC.** `createOperationsIam` gains a second
   verifier, `createIam(env, { appId: 'vozka', tokenAudience: { kind: 'resource', app: 'vozka', resource } })`, the
   one Control's MCP route uses. A request is verified by exactly one of them, chosen by the token's `typ`. The
   resource URI comes from a new Operations variable (rollout below); without it the resource verifier is off.
3. **The proxy still decides.** The resource token reaches Operations only through Control's private hop. The
   console's `operations-rpc` row admits no `oauth` caller, so an MCP client cannot call `/operations/api/rpc` itself
   (assumed from the row's `callers`; PR 1 adds the test that proves it).

### What the token carries: a separate `operations` scope

The `authoring` scope's ceiling lists only the source and deploy actions
(`packages/platform-artifacts/src/proxy-manifest.ts:59-72`), and IAM narrows a resource token's permissions to the
ceiling of its consented scopes (`scopeCeiling`, `packages/iam/src/oauth.ts:245-253`). So no Operations action reaches
an MCP token today.

Add a second scope, `operations`, to the console's MCP resource, with the ceiling `operations.read` and
`operations.triage` (never `operations.manage`). Make it a default scope, so a new consent includes it. Do not widen
`authoring`: IAM re-resolves a grant's ceiling at every refresh, so widening `authoring` would give every existing
consent Operations access the person never saw on the consent screen. A grant consented before this change keeps
`authoring` only; its Operations tools answer "this connection was authorized without the `operations` scope;
reconnect to read errors". The `/mcp` row keeps requiring `authoring`.

This follows one rule for the console's MCP resource: one scope per feature. `authoring` stays as it is,
`operations` is this spec's, and `review` (`review.read`, `review.write`) is the
[review widget's](./review-widget-on-stage-and-dev.md). A tool checks that the token's `oauth.scopes` holds its
feature's scope. An [agent task key](./agent-task-keys.md) carries whichever of these scopes its form picks, and the
exchange puts them in `oauth.scopes`, so the same check serves a person's connector and an agent's task.

The person's own grants still bound the token: someone without `observer` at an app sees nothing of it.

### Which environments the tools read: stage and dev only

Error payloads can carry end-user data: request paths, breadcrumbs, exception messages built from input. An MCP
client sends tool results to a third-party model. The tools therefore read only the sources of environments the
authoring flow already exposes: an application's authoring target that is not protected (`AppEnvDto.authoring` and
`!protected`) and its `dev` environment (`APP_ENV_KINDS`, `packages/control-contract/src/index.ts:214-231`). A source
of any other environment, production included, answers `not_found`, as if it did not exist.

`authoring` alone does not prove "not production": Control refuses a second authoring environment per app
(`packages/control/src/api/registry/environments.ts:45-50`) but not an authoring flag on a protected one; "never mark
production" is only an operator instruction ([`reference/mcp-authoring.md`](../reference/mcp-authoring.md), setup
step 3). So the filter checks `protected` too, and PR 2 makes `apps.environments.put` refuse `authoring: true` on a
protected environment (and `protected: true` on an authoring one) with a 409. Control applies this filter before it calls Operations; it is
authorization at the tool, not an enforcement decision.

Reading production is an open question (below); the default is no.

### What a tool returns of an event

`get_issue` returns a projection of `EventDetail` (`packages/operations-contract/src/operator.ts:61-76`), never the
whole value:

| Kept                                                                                         | Dropped                              |
| -------------------------------------------------------------------------------------------- | ------------------------------------ |
| exception type, value (cut to 1 KiB), frames (in-app first, at most 50, with source context) | `rawEvent`                           |
| tags (`endpoint`, `code`, `job` and the rest, each value cut to 200 characters)              | `user` (id, email, username)         |
| release, environment, runtime, trace id                                                      | the request URL's query and fragment |
| request method and URL path                                                                  | breadcrumb `data`                    |
| the last 20 breadcrumbs: timestamp, category, level, message cut to 240 characters           |                                      |

Ingest has already redacted URL fragments, `Authorization` headers and `px_` credentials
(`packages/operations/src/redact.ts:1-3`). The projection is a second, MCP-specific rule on top of that, in Control.

### Prompt injection

An issue title, an exception message and a breadcrumb are written by end users and by application code. Every such
string is returned under an `untrusted` object of the tool result, never in the tool's prose. The server instructions
(`WORKSPACE_INSTRUCTIONS`, `packages/control/src/mcp/handler.ts:59-63`) already say that repository files and build
logs are untrusted data; they add Operations events. The only write tool comments on or resolves an issue, so an
injected instruction can at worst produce a wrong comment, which the issue's activity shows with its actor.

### The workspace names its stage issues

`get_workspace` (`packages/control/src/api/workspaces.ts:267`) already returns the workspace's `latestRun` and whether
it is `onStage`. When that run deployed the authoring target, Control adds `stageIssues`: at most 10 issues the
release of that run's commit introduced, each with id, title, count and `attribution`.

The existing procedures cannot answer this. `releases` filters only by source and cursor
(`releaseQuery`, `packages/operations/src/operator-rpc-input.ts:47-52`), and `release` lists every issue with an
applied occurrence in the release (`listReleaseIssues`, `packages/operations/src/repositories/operator.ts:406-420`), so
a long-standing issue that also fired on the new release is listed beside the ones it caused, without a bound.
Operations therefore gains:

- **A `commitSha` filter on `releases`.** A release is unique by source and commit, so `{ sourceId, commitSha }`
  answers at most one release. Control looks up by commit, not by run: the release row keeps only the latest observed
  `run_id` of its commit.
- **A `releaseIssues` procedure**, `{ releaseId, limit }` (limit 1–50), answering only the issues the release
  introduced, each with `attribution`:
  - `new`: the issue's first occurrence is in this release (`issue.first_seen` equals an applied occurrence's
    `received_at` of this release);
  - `regressed`: an applied occurrence of this release has `transition_kind = 'regressed'`.

  These are the predicates of the release's `newIssueCount` and `regressionCount`
  (`packages/operations/src/repositories/operator.ts:497-508`), so the list and the counts cannot disagree. Ordered by
  `last_seen` descending; an issue both new and regressed in one release is `new`. Authorized like `release`
  (`operations.read` at the release's source). The [release watch window](./release-watch-window-and-rollback.md)
  reads the same procedure.

## API and contract changes

New MCP tools (all `openWorldHint: false`):

| Tool           | Input                                                                                       | Output                                                                                                           | Annotation                      |
| -------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `list_issues`  | `appId`, `env`, `serviceKey?`, `status?`, `window?`, `sort?`, `query?`, `cursor?`, `limit?` | items: id, level, status, firstSeen, lastSeen, count, regressedAt, `untrusted: { title, culprit }`; `nextCursor` | read-only                       |
| `get_issue`    | `issueId`, `occurrenceId?`                                                                  | the summary, `resolvedInRelease`, comments, the projected event, its release with `runId` and `commitSha`        | read-only                       |
| `get_health`   | `appId`, `env`                                                                              | per source: HTTP checks (path, current state, last 10 observations), telemetry state                             | read-only                       |
| `update_issue` | `issueId`, `{ kind: 'comment', text }` or `{ kind: 'resolve_in_release', releaseId }`       | the updated summary                                                                                              | not destructive, not idempotent |

`update_issue` maps to `mutateIssue` (`packages/operations/src/operator-rpc.ts:30-31`). It offers no status change,
assignment, snooze or merge; those stay in the console. `resolve_in_release` names a release of the issue's own source.

`get_workspace` and `list_workspaces` gain `stageIssues` (above). `WorkspaceDto` is a Control MCP output, not a
console contract; nothing in `@fabrika/control-contract` changes.

Operations: `createOperationsIam` gains the resource verifier. `OperationsRpcContract`
(`@fabrika/operations-contract/rpc`) changes additively: `releases` takes an optional `commitSha`, and the new
`releaseIssues` answers `{ items: (OperationsIssueSummaryDto & { attribution: 'new' | 'regressed' })[] }`. The console
keeps working unchanged; both are installation-internal.

Control: `apps.environments.put` refuses `authoring` together with `protected` (409).

IAM: the console's MCP resource gains the `operations` scope and its grant, carried in `FABRIKA_IAM_OAUTH_CONFIG`
(`packages/installation-init/src/mcp.ts:76-103`). No IAM code changes.

**Not protocol.** Nothing here touches what an application and the platform exchange
([ADR-0062](../decisions/0062-a-platform-release-serves-older-framework-releases.md)): no contract artifact, manifest
row of an application, `X-Fabrika-*` header, token claim or `FABRIKA_*` variable an application reads. The MCP tool
list is an installation surface.

No schema change and no migration: `releaseIssues` reads existing columns.

## Security and permissions

- **Enforcement** stays the proxy's: the `/mcp` row admits the `oauth` caller with the `authoring` scope; the
  `operations-rpc` row keeps admitting no `oauth` caller.
- **Authorization** is Operations': `operations.read` for the three reads and `releaseIssues`, `operations.triage` for `update_issue`, at
  the source's app or environment, from the token's narrowed permissions. Control adds one rule: sources of an
  unprotected authoring environment and of the dev environment only.
- **Admission** is unchanged: the MCP row has its own; the private hop to Operations is not fronted.
- **Ceiling.** A token never carries more than the person's live grants intersected with `operations.read` and
  `operations.triage`. `operations.manage` (alert channels, health checks) never reaches an MCP token.
- **Audit.** A triage write is recorded by Operations as today (`operations.issue.comment`,
  `operations.issue.status`, `packages/operations/src/access.ts:53-80`), under the console app, through the resource
  token's signed `app`. The issue's activity names the person. Reads are not audited, as in the console.
- **Data leaving the installation.** Only stage and dev events, projected as above. This is a stated, accepted risk
  in ADR-0049 when it is rewritten: stage may hold real people's data when people test on it.
- **Revocation.** A revoked grant stops refreshes; an issued access token reads Operations until its `exp`, at most
  300 s, as for every other MCP tool ([backlog 196](../backlog/196-mcp-authoring-has-no-live-acceptance.md) item 2).

## Rollout on an existing installation

1. **Generated files.** The Zerops platform proxy manifest template
   (`packages/provider-zerops/src/installation/generated/platform-proxy-manifest.ts`) is regenerated with the new
   scope and grant. `fabrika platform upgrade` deploys the platform from the new release, so the new template reaches
   an existing installation with the upgrade.
2. **Environment variables.** The deploy writes `FABRIKA_IAM_OAUTH_CONFIG` from the template on every deploy
   (`deployedServiceEnvironment`, `packages/installation-init/src/service-environment.ts:160-185`), so IAM gets the new
   scope on upgrade. Operations gets one new variable, the console's MCP resource URI, derived from the console host
   the same way; it is written only where MCP authoring is on. An installation that has not redeployed Operations has
   the variable unset, and the Operations tools answer "Operations does not accept MCP tokens yet; ask the operator to
   upgrade".
3. **Provider state.** An existing environment may already carry both `authoring` and `protected`. The tool filter
   excludes it at once; the registry refusal applies at its next `apps.environments.put`, which then must clear one of
   the two. No upgrade step changes registry rows.
4. **Floating pins.** None.

Existing MCP consents keep working for every authoring tool; they gain Operations only after the person reconnects.
Cloudflare installations have no MCP authoring (ADR-0049 rule 9), so nothing changes there.

## Test plan

- `packages/operations/src/__tests__/operator-api.test.ts` (or a sibling `operator-mcp-token.test.ts`): a resource
  token for the configured resource with `operations.read` lists only its permitted sources' issues; a resource token
  for another resource, or with the variable unset, is 401; a resource token without `operations.triage` cannot
  comment; a native token behaves as before.
- `packages/platform-artifacts/src/__tests__/proxy-manifest.test.ts`: the console resource has scopes `authoring` and
  `operations`, the `operations` grant is exactly read and triage, and `authoring`'s grant is unchanged.
- A proxy-core test that an `oauth` bearer on `/operations/api/rpc` of the console table is refused.
- `packages/control/src/__tests__/mcp.test.ts`, against a fake Operations service:
  - `list_issues` on a production environment answers `not_found` and makes no Operations call;
  - `get_issue` drops `rawEvent`, `user` and the URL query, and every end-user string sits under `untrusted`;
  - a token without the `operations` scope gets the reconnect message;
  - `update_issue` refuses `status`, `assign` and `merge` kinds at the input schema;
  - `list_issues` on an authoring environment that is also protected answers `not_found`;
  - `get_workspace` names the issues the release of the latest stage run's commit introduced, and none when the run
    did not deploy the authoring target.
- `packages/control/src/__tests__/` registry tests: `apps.environments.put` answers 409 for `authoring: true` on a
  protected environment and for `protected: true` on an authoring one.
- `packages/operations/src/__tests__/operator-api.test.ts`, on SQLite and on Postgres: for a release, a long-standing
  issue with an occurrence in it is not in `releaseIssues`, an issue first seen in it is `new`, a resolved issue that
  recurred in it is `regressed`; `limit` bounds the answer; `releases({ sourceId, commitSha })` answers the one
  release of that commit; a caller without `operations.read` at the source gets `not_found`.
- `packages/installation-init/src/__tests__/service-environment.test.ts` pins the new Operations variable name.

## Slicing into PRs

1. **Operations accepts the MCP resource token; the `operations` scope** (S). The second verifier, the variable and
   its derivation, the scope and grant in the template, the regenerated Zerops template. Witness: the Operations
   resource-token tests, the manifest test, the proxy-core refusal test.
2. **The three read tools** (M). Control's Operations client, the stage/dev filter, the registry refusal of
   `authoring` on a protected environment, the event projection,
   `list_issues`, `get_issue`, `get_health`, server instructions, `reference/mcp-authoring.md` tool table, ADR-0049
   rewritten in place (Operations tools, the `operations` scope, the stage-only rule). Witness: `mcp.test.ts` cases
   above.
3. **`update_issue` and `stageIssues`** (S–M). `releases`' `commitSha` filter and `releaseIssues` in Operations, then
   the tool and the workspace field. Witness: the attribution cases of `operator-api.test.ts`, the triage and
   workspace cases of `mcp.test.ts`.

Each PR ships alone: after PR 1 nothing calls the new verifier; after PR 2 the agent reads; PR 3 adds the write.

## Open questions

1. **May the tools read production?** Default: no in this work. When an installation needs it (the self-healing
   loop, [backlog 270](../backlog/270-a-self-healing-loop.md)), add one installation setting that admits production
   sources, decided with [masked production data](../backlog/269-masked-production-data-for-dev-and-stage.md), not a
   per-call flag.
2. **Resolve in a release that does not exist yet.** A fix to a production issue ships only after the merge, so no
   release of that source holds the fix commit when the agent is done. Default: the agent comments with the pull
   request; the release watch window decides whether a later release resolves it. A pending "resolve when commit X
   ships" mutation is not built here.
3. **Does the issue's activity name the MCP client?** Default: yes, add the OAuth client id to the comment activity's
   data, so a reader tells a person's comment from their agent's. [Agent task keys](./agent-task-keys.md) replace this
   with the `act` claim once they exist.
4. **Do MCP clients request a default scope they were not offered on first connect?** Assumed: IAM's
   `defaultScopes` apply when a client requests none. To verify against Claude and ChatGPT connectors in PR 1; if a
   client requests only `authoring`, its users reconnect after the operator adds `operations` to the client's
   registration.
