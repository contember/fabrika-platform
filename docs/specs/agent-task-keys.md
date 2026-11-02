# Agent task keys

A person hands an agent a short-lived, budgeted key for one application. Every token the agent gets from it names
both the person and the agent, so audit, commits and the console tell "the person did it" from "the person's agent did
it".

- **Size:** M (five PRs, none larger than M).
- **Depends on:** nothing. It reuses IAM's OAuth resource tokens ([ADR-0049](../decisions/0049-author-applications-through-mcp-in-control.md)).
- **Enables:** [Operations tools in the authoring MCP](./operations-tools-in-the-authoring-mcp.md) for unattended
  agents, [the release watch window](./release-watch-window-and-rollback.md) handing a fix to an agent, and the
  self-healing loop ([backlog 270](../backlog/270-a-self-healing-loop.md)).

## Problem

An agent that acts for a person today holds one of two credentials:

- **The person's OAuth grant** (MCP authoring). Its token carries the person's live grants narrowed by the
  `authoring` scope (`packages/iam/src/oauth.ts:223`). Nothing in the token says an agent holds it, and the grant lives
  as long as the person's IAM session, up to 30 days. An agent runner without a browser cannot get one at all: the
  grant starts with an authorization code (`packages/iam/src/oauth-http.ts:64` lists only `authorization_code` and
  `refresh_token`).
- **A `px_` key.** A self-bound key carries the person's live permissions for up to 30 days
  (`MAX_KEY_LIFETIME_SECONDS`, `packages/auth-core/src/rpc.ts:184`); the builder's device key is a separate service
  principal ([ADR-0042](../decisions/0042-connect-local-builders-through-human-consent.md)). Neither reaches Control's
  `/mcp`: the console row admits only the `oauth` caller (`packages/control/fabrika.service.ts:60`), and the handler
  requires an OAuth token of a user (`packages/control/src/mcp/handler.ts:108`).

So audit cannot separate a person from their agent: a workspace commit carries `Fabrika-Principal` and
`Fabrika-Client` trailers only (`packages/control/src/api/workspaces.ts:760`), and an `audit_events` row has one
principal (`packages/iam/migrations-postgres/0001_init.sql:168`). Nothing bounds how many commits, deploys or
workspaces one task may produce, or which files it may touch beyond the protected paths
(`packages/control/src/api/workspaces.ts:753`).

## Design

### What a task key is

A task key is **an OAuth grant of a new kind, `task`**, whose secret the agent exchanges for the ordinary resource
token of the console's `/mcp` resource. It is not a `px_` key and not a new token kind. This is the smallest change
that keeps every enforcement and verification path as it is:

- The proxy verifies the token locally, as it verifies every OAuth bearer on the `/mcp` row
  (`packages/proxy-core/src/authorize.ts:434`). No proxy change, no change to the console's endpoint table, so
  `FABRIKA_SERVICE_TABLE_DIGEST` stays the same.
- Control's `/mcp` gate (an OAuth token of a user) admits it unchanged: the subject is still the person.
- Approval stays closed: `requireHumanApprover` refuses any token with OAuth claims
  (`packages/control/src/approval/human.ts:21`), so an agent never approves its own widening.

Rejected: a `px_` key variant. The proxy would exchange it, but the `/mcp` row and Control's gate would have to admit a
`human` key caller, which changes the installation table and widens the row for every `px_` key, not only task keys.

### Issuance (the consent)

A person issues a task in the console. The form is the consent screen of the task, frozen like a device approval
(ADR-0042 §4). It names:

- the application and its authoring environment (one per app, `packages/control/CLAUDE.md`, "MCP authoring");
- the actions, a subset of the `authoring` scope's grants (`source.workspace.read`, `source.workspace.write`,
  `source.pull-request.create`, `deploy.trigger`, `deploy.read`; `docs/reference/mcp-authoring.md`), plus the
  Operations actions once [the Operations tools](./operations-tools-in-the-authoring-mcp.md) exist;
- the lifetime in hours (default 4, at most 24);
- budgets: commits, deploys, workspaces (each optional, each at most 1000);
- optional path globs that `apply_changes` may write (at most 16, each at most 200 characters);
- the agent's label (what audit and commits show, e.g. the runner's name).

The console calls IAM's `/admin/rpc` `tasks.issue` through Control's IAM gateway. Like `appPeople.*`, it is an
exception to "every procedure requires `iam.admin`": a user behind a signed-in session's console token
(`AccessTokenClaims.session`, `packages/auth-core/src/token.ts`) issues tasks for itself only. A `px_` key, an OAuth
token and a task token never issue one, so an agent cannot mint a longer or wider task for another agent. IAM refuses
the issue when the person does not hold every listed action at the app now, so a task is never silently empty.

IAM stores an `agent_tasks` row (both migration sets): id (UUIDv7), principal, app (`vozka`), resource, the frozen
ceiling (actions, scope `app:<id>`), the target environment, budgets, globs, agent label, `expires_at`, `revoked_at`,
and the SHA-256 of the secret. The secret (`pt_` + 27 base64url characters, a prefix the proxy's `px_` branch never
takes) is shown once. `tasks.list` and `tasks.revoke` act on the caller's own tasks; `iam.admin` may list and revoke
anyone's. Issue and revoke write `iam.task.create` / `iam.task.revoke` in their own transaction
(`packages/iam/CLAUDE.md`, "every IAM-owned change").

A separate table, not `oauth_grants`: that row requires a session (`session_id NOT NULL`,
`packages/iam/migrations-postgres/0002_oauth.sql:6`) and dies with it, while a task must outlive the console tab that
issued it.

### Exchange

The runner calls IAM's token endpoint with an RFC 8693 token exchange:

```
POST <iam>/oauth/token
grant_type=urn:ietf:params:oauth:grant-type:token-exchange
subject_token=pt_…
subject_token_type=urn:fabrika:params:oauth:token-type:task-key
resource=https://<console>/mcp
```

IAM looks the secret up by hash, then resolves authority like `grantAuthority` does for a code or refresh
(`packages/iam/src/oauth.ts:223`): the task live and unexpired, the resource still configured, the principal an active
user, its live permissions at the app narrowed by the task's ceiling (`narrowPermissions`,
`packages/iam/src/narrow-permissions.ts:8`). It mints the resource token as `mintForGrant` does
(`packages/iam/src/oauth.ts:187`), with three differences: the TTL is 60 s instead of
`DEFAULT_TOKEN_TTL_SECONDS` (300), `exp` is also capped at the task's expiry, and the token carries `act`. No refresh
token is issued; the runner exchanges again. A failed exchange is `invalid_grant`, the same for an unknown, revoked,
expired or foreign secret. The endpoint is public, so it takes the per-client bucket before the lookup, like
`/auth/workload/token`.

The OAuth claims need a `client_id`. A task has no client of its own, so IAM serves one fixed Client ID Metadata
Document for task exchanges at `<iam>/oauth/clients/task` (public client, no redirect URI, the token-exchange grant
only). That URL passes `isCimdClientId` (`packages/auth-core/src/oauth.ts:16`) unchanged.

The agent then calls `https://<console>/mcp` with `Authorization: Bearer <token>`, one credential per request.
Any MCP client that accepts a bearer works; an external agent runner (for example roj) needs only "exchange, then call
with a bearer, exchange again before `exp`".

### Control's enforcement

Control already authorizes every tool at the coordinates. A task token adds four checks, all in the shared use cases of
`packages/control/src/api/workspaces.ts` and `packages/control/src/api/dev-environments.ts`, read from
`AuthContext.actor`:

1. **Target.** A use case refuses a workspace or target of another application than `act.target.app`, with the same
   404 as a denied one.
2. **Path globs.** `applyChangesUseCase` refuses a batch with a path no glob matches (403, naming the paths), beside the
   protected-path check (`workspaces.ts:477`). Globs match with `Bun.Glob`, as `search_files` does (`workspaces.ts:419`);
   the MCP host is Bun-only.
3. **Budgets.** Control spends a unit before the effect, in one conditional statement
   (`UPDATE agent_task_usage SET commits = commits + 1 WHERE task_id = ? AND commits < ? RETURNING`), the pattern of the
   deploy lock: no read-then-write race, the same on SQLite and Postgres. A spent budget is a 403 that names the budget
   and its limit. A unit is not refunded when GitHub or the provider then fails; the budget is an upper bound. What
   counts: `apply_changes` a commit; `deploy_stage` and every run `bind_dev` or `reset_dev` creates a deploy;
   `create_workspace` a workspace.
4. **Attribution.** Each workspace a task creates records `created_by_task`. Commit messages add
   `Fabrika-Task: <task id>` and `Fabrika-Agent: <label>` to the existing trailers; the author stays the person, who is
   accountable. `create_pull_request` names the task and the agent in the body.

The usage row lives in Control because Control runs the effects. Its limits come from the signed token, so Control
keeps no copy of the task.

### Audit

`IamRpc.audit` already verifies the caller's token to find the app (`packages/iam/CLAUDE.md`, "`audit` records the app
of the caller's verified token"). It also reads `act` from that verified token and writes it to two new
`audit_events` columns, `actor_task_id` and `actor_label`, never from the event's own fields. IAM's own records of
`tasks.*` write them too. The console's audit view shows "agent `<label>` for `<person>`". Delivery stays best-effort
([backlog 71](../backlog/71-deliver-domain-audit-events-durably.md)).

## API and contract changes

- **`@fabrika/auth-core`.** `AccessTokenClaims.act?: { sub: string; label: string; target: { app: string; env: string }; budgets: { commits?: number; deploys?: number; workspaces?: number }; paths?: string[] }`.
  `sub` is the task id. `buildAccessClaims`/`buildResourceAccessClaims` and `parseAccessClaims` accept it **only beside
  OAuth claims**, and the parser refuses a malformed or misplaced one rather than dropping it. New constants: the
  task-key token type URN, `TASK_KEY_PREFIX`, `TASK_TOKEN_TTL_SECONDS` (60), `MAX_TASK_LIFETIME_SECONDS` (24 h).
- **`@fabrika/auth`.** `AuthContext.actor?: { taskId; label; target; budgets; paths }`, from `claims.act`.
  Optional and additive.
- **IAM.** `/admin/rpc` `tasks.issue | list | revoke`; `/oauth/token` gains the token-exchange grant;
  `/oauth/clients/task` serves the CIMD document; the authorization server metadata lists the grant. Migrations:
  `agent_tasks`, two `audit_events` columns.
- **Control.** Migrations: `agent_task_usage (task_id, commits, deploys, workspaces)`, `workspaces.created_by_task`.
  No new RPC; the console reads tasks from IAM through the gateway.
- **Dashboard.** A "Tasks" panel on the application: issue (showing the secret once), list, revoke.

**ADR-0062.** The change does not touch the protocol between an application and the platform. A task token is a
resource token whose `aud` is the console's `/mcp` resource; an application row cannot admit the `oauth` caller (an
installation-only form, `packages/auth-core/src/installation-endpoint.ts`), so no task token ever reaches an
application, and `act` is refused on a native token. An older parser would drop `act` silently (`parseAccessClaims`
builds its result from known fields only, `packages/auth-core/src/token.ts:337`), which is why only one platform
release verifies these tokens: IAM, the platform proxy and Control upgrade together.

## Security and permissions

- **One credential per request (ADR-0022).** The agent presents only the resource token; `act` rides inside it. The
  task secret goes only to IAM's token endpoint, never to the proxy or Control.
- **Never wider than the issuer.** Every exchange re-resolves the person's live permissions and narrows them by the
  task's frozen ceiling; `authorityDeadline` caps `exp` at the supporting grants' end. A disabled person, a lost
  grant or a removed resource ends the task at the next exchange.
- **Vocabulary.** The proxy's admission of the `oauth` caller on `/mcp` is the enforcement decision, unchanged. Target,
  globs and budgets are Control's **authorization**, like its scoped use-case checks; they refuse but decide nothing
  the proxy decides.
- **Budget consistency.** Each spend is one conditional statement against Control's database; two Control processes
  share it. A unit spent before a failed effect is lost, never double-granted.
- **Revocation latency.** Revocation stops the next exchange at once; a token already minted lives at most 60 s, below
  the 300 s an ordinary OAuth access token outlives its revocation ([backlog 196](../backlog/196-mcp-authoring-has-no-live-acceptance.md)
  item 2). The cost is one exchange per minute per agent.
- **Who issues.** A signed-in person, for themselves, from the console. No key, OAuth token or task token issues.
  Ending a person's IAM sessions does not end their tasks; their lifetime is bounded by 24 h and by revocation.
- **Secret custody.** IAM stores the hash only, shows the plaintext once, and never logs it. A leaked secret reaches
  one application's authoring target, within the budgets, for at most 24 h.
- **Prompt injection.** A task narrows what an injected instruction can do (globs, budgets, no approval), but it
  does not make repository text trustworthy; the server instructions keep saying so.

## Rollout on an existing installation

1. **Generated files.** None change. `FABRIKA_IAM_OAUTH_CONFIG` keeps its shape: a task uses the existing resource and
   its `authoring` scope.
2. **Environment variables.** None added, renamed or removed.
3. **Provider state.** None. The IAM and Control migrations are additive and run on `upgrade` like every migration
   (ADR-0017). An existing OAuth grant and its tokens are untouched.
4. **Floating pins.** None.

MCP is served only by the Bun host, so task keys work wherever `/mcp` does (Zerops today); IAM's half is portable.

## Test plan

- `auth-core`: `act` builds and parses only beside OAuth claims; a malformed `act`, `act` on a native token, and `act`
  without `target` are refused (`token.test.ts`, `resource-token.test.ts`).
- IAM, both engines: issue refuses a `px_` caller, an OAuth caller, an action the person lacks, a lifetime above 24 h;
  exchange mints a 60 s token with `act`; revoked, expired and unknown secrets answer the same `invalid_grant`; a
  person who lost a grant gets the narrower set; a disabled person gets nothing; the bucket refuses a burst.
- Control: a commit outside the globs is 403; the n+1th commit, deploy and workspace are 403 and spend nothing on a
  concurrent pair (Postgres test); a task token for app A gets 404 on app B; trailers name the task; a task token cannot
  complete an approval.
- Audit: `IamRpc.audit` with a task token writes `actor_task_id` from the token, whatever the event says.
- End to end in the local stack: issue in the console, exchange with `curl`, drive `create_workspace` and
  `apply_changes` over `/mcp`, revoke, and see the next exchange fail.

## Slicing into PRs

1. **The `act` claim (S).** `auth-core` claim, builders, parser, constants; `AuthContext.actor`. Nothing mints it yet.
   Witness: the claim tests above.
2. **Control enforcement (M).** Target, globs, budgets, attribution, migrations. Inert without task tokens.
   Witness: Control tests with tokens the test signs.
3. **IAM tasks and exchange (M).** `agent_tasks`, `tasks.*`, the token-exchange grant, the task CIMD document, the
   bucket. Witness: IAM tests on both engines.
4. **Audit attribution (S).** The two columns, IAM reading `act` in `audit` and its own records; the audit view
   column. Witness: the audit test above.
5. **Console and docs (M).** The Tasks panel, `docs/reference/mcp-authoring.md` (how a runner uses a task key), the
   ADR. Witness: a browser test in `tests/browser` that issues, lists and revokes a task.

## Open questions

- **Issuing from MCP.** Should a person's own MCP client issue a task for another agent? Default: no. An OAuth token
  minting a credential for someone else is the escalation ADR-0042 keeps closed.
- **Unattended issuance.** The self-healing loop needs a task when no person is present. Default: out of scope here;
  backlog 270 decides whether a person pre-approves a standing task template that an alert instantiates.
- **Environment-scoped grants.** The ceiling is scoped to the app, so a person whose grant is scoped only to an
  environment name loses it under a task (`narrowerScope`, `packages/iam/src/narrow-permissions.ts`). Default: accept
  and say so on the form; the authoring environment is one per app.
- **Ending tasks with the session.** Default: a task outlives logout, bounded by 24 h; the Tasks panel has "revoke
  all".
- **Device-flow issuance.** A runner could start an ADR-0042 device authorization and the person approve a task in
  the browser. Default: later, if pasting the secret into the runner proves to be the friction.
