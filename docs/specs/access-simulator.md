# Access simulator

**Summary.** For an application environment, show what a principal reaches and why: every endpoint with allow or
deny and the reason. Replay a refused request. Count the people an approval gives or takes access. The answer comes
from the proxy's own decision code, run offline over the approved table.

**Size.** M (five PRs, the largest M).

**Depends on.** Nothing. Each PR stands on code that exists today.
**Enables.** [Agent task keys](./agent-task-keys.md) (explain what a task key reaches before it is issued),
[operations tools in the authoring MCP](./operations-tools-in-the-authoring-mcp.md) (one more read tool beside them).

## Problem

"Why can this person not see the deals page" has no answer in the console. An operator reads the contract, the
person's grants and the role definitions, and repeats the proxy's rules by hand. The rules are not small: one selected
endpoint and no fall-through, the caller kind, the export-path rule for connectors, the requirement and its scope
semantics, then admission (ADR-0022 §3).

An authoring agent that meets a 403 on stage cannot tell a missing grant from a wrong caller kind. ADR-0050's context
names the failure mode: the agent loosens the contract instead.

A refused request leaves one log line. The proxy logs `deny` with the request id, app, host, method, path, reason and
status (`packages/proxy-core/src/service.ts:331`), but no subject, and the refusal sent to the client carries no
request id: only the allow sets `X-Request-Id` (`service.ts:188`). A person who was refused has nothing to quote.

The approval page groups changes by audience (reach and requirement, `packages/control/src/approval/diff.ts:175`,
`ChangeAudienceDto` in `packages/control-contract/src/index.ts:540`), but never says how many people are in that
audience.

## Design

### The decision is called, never re-stated

The enforcement decision is `Authorizer.authorize` (`packages/proxy-core/src/authorize.ts:248`). Below the request
parsing it does four things over one row: `planEndpoint` (`authorize.ts:265`), the caller (`endpointCaller`,
`authorize.ts:371`: `px_` key, OAuth bearer, or session), `callerOf` + `callerAdmittedAt` + `satisfies`
(`authorize.ts:313`), then admission and the delegation grant. Credentials reach it only through the `IamGateway`
seam (`packages/proxy-core/src/iam.ts:47`): `mintToken`, `mintFromKey`, `getJwks`.

The simulator runs that same `Authorizer`, unchanged, against an in-memory `IamGateway`:

- An ephemeral ES256 key is generated per simulation. `getJwks` serves only it; the issuer is a fixed
  `urn:fabrika:simulation` that no verifier anywhere trusts.
- `mintToken` (a person's session) and `mintFromKey` (a key) return a token signed with that key over **preview
  claims**: the claims IAM would mint for the principal, read from IAM without signing (below).
- The token cache is `null` (`AuthorizerOptions.cache`), so every simulation is cold. The proxy's cache changes no
  decision anyway (ADR-0022 §1 invariant).
- The `DelegationIssuer` returns a marker grant. A row that spends one is reported as "the proxy admits; IAM then
  checks the membership write", because the membership rules run in IAM (`packages/iam/src/membership.ts`), not in
  the proxy.

This lives in a new public subpath, `@fabrika/proxy-core/simulate`, beside the decision, so its tests sit next to the
truth tables (`deny-matrix`, `endpoint-matrix`). It imports `Authorizer` and adds no rule. A rule added to
`authorize.ts` reaches the simulator with no change to it.

**Why not extract a pure `decideClaims` from `decideRow`.** That also avoids a second decision, but it edits the
enforcement code for a reporting feature, and admission and the caller resolution would stay outside it. Running the
whole `authorize` through the existing seam needs no edit to `authorize.ts`.

### The request a simulation sends

For each row of the table, the simulator builds the request a well-formed client of that row sends:

- Method: the row's (`*` rows exist only on installation entries; the simulator serves contract applications only,
  `isApplicationEntry`).
- Path: the row's pattern with each `:name` segment and a terminal `*` filled with a placeholder. Before it calls
  `authorize`, it runs `planEndpoint` on that path; if another row wins (a more specific one), it tries a second
  placeholder, and otherwise reports the row as "shadowed by `<id>`" instead of a verdict.
- Content type: the first one the row admits.
- Credential and browser headers: set together, by a named **client scenario**, because the decision reads them
  together. A session write is refused unless `Sec-Fetch-Site` is `same-origin` (`authorize.ts:345`), and a request
  from a listed origin is never session-authenticated (`endpointCaller`, `authorize.ts:371`). Changing `Origin` alone
  would describe a request no browser sends. The scenarios:
  - **Same-origin page** (the default for a person): the `__Host-px_session` cookie, `Sec-Fetch-Site: same-origin`, no
    `Origin` on a `GET`, the entry's own origin otherwise.
  - **Page on a listed origin**: `Origin` one of the entry's `crossOrigins`, `Sec-Fetch-Site: cross-site`, no cookie
    (the cookie is `SameSite=Lax`, `service.ts:403`, and a session does not cross origins), the key as a bearer when
    the principal has one.
  - **Page on an unlisted site**: a foreign `Origin`, `Sec-Fetch-Site: cross-site`, the cookie only on a top-level
    `GET` navigation (what `Lax` sends).
  - **Non-browser client** (the default for a key): `Authorization: Bearer px_…`, no `Sec-Fetch-*`, no `Origin`, no
    cookie.

  The page names the scenario beside every verdict. `cross_site` and `cross_origin` appear only under the scenarios
  that produce them.

The verdict per row is the `Decision` (`authorize.ts:104`): allow, deny with its `DenyReason`
(`authorize.ts:56`), or login. Each `DenyReason` gets one fixed sentence. Two get detail from the inputs:

- `insufficient_permission`: the requirement in the approval page's words (`requirementPhrase`, `diff.ts:1468`) and
  the principal's entries for that action. `satisfies` (`packages/auth-core/src/requirement.ts:14`) accepts an
  action "in some scope, global included"; an `app` form needs it global.
- `caller_kind`: the principal's caller kind (`callerOf`, `requirement.ts:40`) and the row's callers. A job, webhook
  or public-procedure workload is no caller kind and is refused by every row; the page says so once instead of per row.

### Where the answer stops

The proxy admits a scoped action if the principal holds it in any value. Whether a given record is visible is the
application's: the access form narrows to one scope against the application's data, then table policies and
`.require`/`can()` run inside the handler (authorization, not enforcement, root `CLAUDE.md`). Every allow on a scoped
requirement says: "admitted by the proxy; which records is decided by the application." The simulator never guesses
a row-level answer.

It also stops at time. A replay answers against today's grants and today's approved table, not those of the moment a
request was refused.

### Preview claims from IAM

IAM already computes a principal's permissions at one application for its admin views: `principals.get` calls
`resolvePermissionsAt` per app (`packages/iam/src/admin/principals.ts:65`, `:75`). The mint fronts use the same core:
`mintToken` calls `resolveAuthorityAt` (`packages/iam/src/tokens.ts:56`, `packages/iam/src/resolve.ts:362`) and
`mintFromKey` calls `resolveCredential` (`tokens.ts:227`, `tokens.ts:350`).

A new admin procedure, `access.preview`, answers the claims a fresh mint would carry, unsigned:

- **Person**: `{ sub, ptype: 'user', session: true, perms, email }` from `resolveAuthorityAt` at `<app>@<env>`.
  `disabled` and `unknown_principal` come back as reasons. A terminal session is out of scope (ADR-0067); the page
  says the answer is for a session not asserted at a terminal.
- **Key** (by credential id): first the validity `mintFromKey` gets from its lookup. The real mint reads the
  credential with `getActiveCredentialByHash` (`packages/iam/src/tokens.ts:232`), whose SQL refuses a revoked or
  expired row (`packages/iam/src/repositories/credentials.ts:178`); `getCredentialById` (`credentials.ts:186`) does
  not, and `resolveCredential` checks no validity. So the preview reads the row through a new
  `getActiveCredentialById` with the same predicate (`revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now)`),
  and a revoked or expired key answers `revoked` or `expired` before anything is resolved. Then `resolveCredential`'s
  subject, `ptype`, `workload`, `perms` and `link`. Its refusals come back as they are, `wrong_app` and
  `issuer_unauthorized` included: the caller is an installation administrator, so hiding them (as `mintFromKey` does
  toward a presenter) protects nobody. A workload key takes `mintFromWorkloadKey`'s kind and app checks too
  (`tokens.ts:278`).
- **Token size**: the preview reports when the claims exceed the application token bound
  (`MAX_APPLICATION_TOKEN_BYTES`), because the real mint would answer `token_too_large` (a 403).

No token is signed by IAM's keys. The preview returns JSON claims; only the simulator's throwaway key signs them, in
memory, for one call.

### Hypothetical principals

Most questions are "what does a holder of role `sales` reach". That needs no IAM read: the roles are in the approved
snapshot's schema (`schemaFromContract`, via `approvedAccess`, `packages/control/src/approval/snapshot.ts:140`). The
simulator takes "role R, globally" or "role R in value V of dimension D" and builds `perms` from the role's actions.
Wildcards do not occur: a contract application's roles hold exact actions (`packages/iam/src/contract-rules.ts`).

### The table

The simulated table must be the one the proxy serves, and the providers build it differently:

- Zerops builds a member's table with `contractProxyTable(access.contract, access.contractDigest)`, no ops row
  (`packages/provider-zerops/src/namespace/manifest.ts:63`), and a dev sandbox's from that sandbox's own approved
  access (`manifest.ts:34`).
- Cloudflare passes `{ ops }`, which holds only for a release that serves the ops channel and an environment with a
  domain (`packages/provider-cloudflare/src/provider.ts:389`).
- A `dev` environment has no one table: each ready sandbox is routed by its workspace's own publication
  (`memberSandboxes`, `packages/control/src/api/namespaces.ts:459`).

So Control does not rebuild the table itself. A new optional control-provider capability, `proxyEntry(environment,
{ workspaceId? })`, returns the `ContractProxyApp` the provider would publish, from the same composition inputs and
the same code path the publish uses (Zerops: the member and sandbox branches of `namespace/manifest.ts`; Cloudflare:
`platformProxied`'s inputs, the `ops` gate included). For a `dev` environment the caller names a workspace, and the
entry comes from that sandbox's publication; a workspace without one has nothing to simulate. Control feeds the entry
to the simulator unchanged.

On Zerops a namespace runs the proxy of its pinned source (ADR-0045) until `namespaces update --proxy-source=current`.
Control's copy of the decision can then be newer than the proxy's. The answer names the release it simulated, and on a
namespace whose proxy pin differs from the installation's default the page warns that the live proxy may decide
differently.

### Refused requests

The smallest useful record, with no new store:

1. Every refusal the proxy answers carries `X-Request-Id`, and the 401/403 page shows it as "Reference: `<id>`".
   The page text stays fixed per status and names no reason (proxy-core invariant).
2. The `deny` log line adds `subject` when a credential resolved (a `caller_kind` or `insufficient_permission`
   denial). That needs an optional `subject` on the deny arm of `Decision`; no decision changes.
3. The console's "Explain a refused request" takes method, URL and a principal (or the subject from the log line)
   and runs the simulator. The operator finds the line by the reference in the provider's log (Zerops logs, Workers
   Logs). Nothing collects it into the platform.

Persisting refusals (in Operations, or a store per proxy) would answer "who was refused this week". It adds a write
path on both providers for a feature that has not shown it needs one. Left as an open question.

### People who gain or lose access

On the approval page, beside each audience group: "N people gain this, M lose it". Control asks IAM for the preview
claims of every principal holding a grant at the application, computed twice: with the active roles and with the
candidate snapshot's roles. `computeAuthority` (`resolve.ts:86`) is pure over a `RoleSource`, so IAM can evaluate a
candidate schema without reconciling it.

The verdicts come from the simulator, never from `satisfies` alone. The decision checks the caller kind apart from the
requirement (`authorize.ts:338`), so a row that moves from `human` to `machine` with the same requirement takes access
from every person while `satisfies` still says yes. For each changed endpoint and each person, Control runs the
simulator under the same-origin page scenario twice: the active claims against the active entry, the candidate claims
against the candidate entry (`proxyEntry` over the candidate access). Allow → deny is a loss, deny → allow a gain.
Counts only, and only to an approver who is also an installation IAM administrator (`iam.admin`). Control asks IAM
with the approver's own console bearer, as it does for `access.preview`, and holds no IAM credential of its own for
this: IAM answers the permission sets only to an `iam.admin` caller and audits the read. An approver without
`iam.admin` sees the audience groups without counts, and Control makes no IAM call for them. The page shows no names.
The count is capped (500) and says "500 or more" past it. A GitHub check has no person's token, so the counts never
appear on [the access diff check](./access-diff-as-a-github-check.md).

## API and contract changes

- **`@fabrika/proxy-core/simulate`** (new public subpath): `simulateEndpoints(entry, principal, options)` and
  `simulateRequest(entry, principal, { method, url, origin? })`, returning per-row verdicts. Added to the release
  inventory in `scripts/release.ts`.
- **IAM `/admin/rpc`**: `access.preview` (input: app id, a person id or a credential id) and, for PR 5,
  `access.previewAudience` (input: app id, optional candidate schema; output: per-principal permission sets, ids only,
  capped; `iam.admin` only). Both engines.
- **Provider contract**: an optional `proxyEntry(environment, { workspaceId? })` on the control provider, returning the
  entry it would publish. Both providers implement it from their publish code.
- **IAM repository**: `getActiveCredentialById`, with `getActiveCredentialByHash`'s validity predicate.
- **Control console RPC**: `access.explain` (target app/env, principal: role | person | key, optional request) and
  `access.audience` for the approval page. DTOs in `@fabrika/control-contract`.
- **Console**: an "Access" tab on the environment page; a principal picker; "Explain a refused request".
- **MCP** (Control's `/mcp`): `explain_access` takes a target, a role (and optional scope value), and optionally a
  method and path. Read-only, `readOnlyHint: true`. Scope `authoring`, the scope every `/mcp` call carries: it reads
  the approved contract of an authoring target (or a workspace's publication on `dev`), which the agent already reads
  from the repository, and is authorized with `deploy.read` at those coordinates, as `get_deployment` is. It adds no
  action to the `authoring` ceiling. Roles only: the MCP token is an OAuth resource token, and IAM's
  admin surface refuses a resource token (`verifyAccessToken`), so the agent cannot preview a real person.
- **Proxy answers**: `X-Request-Id` on refusals; the reference on the error page; `subject` on the `deny` log line.

**Protocol (ADR-0062).** None of this touches the app↔platform protocol: no manifest row, no `X-Fabrika-*` header, no
token claim, no `FABRIKA_*` variable. `X-Request-Id` on a refusal goes to the client, not to an application.

## Security and permissions

- **Reading a real principal's access is administration.** `access.preview` takes the gate of what it reveals:
  - a person: an installation administrator, or a user administrator whose scope holds `<app>@<env>`. This is
    narrower than `principals.get`, which a user administrator reads installation-wide (ADR-0058 §3) and which
    already returns the same effective permissions. So no new IAM action is needed.
  - a key or a workload: `iam.admin` only, as `apiKeys.*` and `workloads.*` are (ADR-0058 §3).
- **Audit.** Every `/admin/*` request writes `iam.admin.access` with the procedure before it runs
  (`packages/iam/src/admin/access.ts`), so each preview of a real principal is recorded under the administrator, with
  no extra code. Control forwards the console's own bearer to IAM, so IAM authorizes the caller; Control decides
  nothing about IAM authority.
- **Hypothetical roles** read only the approved contract, which the environment DTO already carries as `surface`
  (`packages/control/src/api/registry/registration.ts:249`). Same gate as that read; no audit row.
- **People counts** reveal no identity and are answered only to an `iam.admin` approver, through that approver's own
  bearer; Control receives principal ids it never shows and has no IAM credential for them.
- **No real credential.** Nothing is minted with IAM's keys. The simulator's key is generated per call, never stored,
  and its issuer is not one any verifier accepts. A simulated token cannot leave the function: the `Decision` it
  returns is reduced to the verdict, and the token field is dropped before Control answers.
- **One decision (ADR-0022).** Guaranteed by construction: the simulator calls `Authorizer.authorize` and reimplements
  nothing. PR 1's witness runs every case of the `endpoint-matrix` and `deny-matrix` suites through both the real
  composition and the simulator and requires the same outcome, status and reason. A rule added to `authorize.ts`
  without a matrix case is the existing gap, not a new one.
- **A refused person learns nothing new.** The reference is an opaque id; the page still names no reason.

## Rollout on an existing installation

1. **Generated files.** None change.
2. **Environment variables.** None added.
3. **Provider state.** None. IAM needs no migration: `access.preview` reads existing tables.
4. **Floating pins.** None. The refusal reference reaches a Zerops namespace only when its proxy pin moves
   (ADR-0045); until then the page has no reference and the simulator still works from method and URL.

## Test plan

- **Simulator equals the decision** (`proxy-core`): every application case of the endpoint and deny matrices, through
  the real `Authorizer` with the test IAM double and through `simulateRequest`, with equal outcome, status and reason.
- **Shadowed rows**: a table where a more specific row wins the placeholder path reports "shadowed", never a verdict
  for the wrong row.
- **Client scenarios**: a session `POST` under "page on an unlisted site" is `cross_site`; the same `POST` under
  "same-origin page" is allowed; a listed origin with no key is `no_credential`, never a login bounce.
- **The served table** (Control, per provider): `proxyEntry` equals the entry the provider publishes for a Zerops
  member (no ops row), a Cloudflare environment on a release that serves ops (with it) and one on an older release
  (without it); for a `dev` environment with two workspace publications, each workspace gets its own table.
- **No token escapes**: the simulator's result type has no token field; a test signs with the simulation key and
  shows the production `TokenVerifier` refuses it (issuer and key).
- **IAM preview, both engines**: a person's claims equal the `perms` a real `mintToken` puts in its token for the same
  rows; a disabled principal answers `disabled`; a revoked key answers `revoked` and an expired one `expired`, where
  `mintFromKey` answers `invalid_key`; a user administrator out of scope gets the same answer as an unknown app; a key
  preview is `iam.admin` only; each call writes one `iam.admin.access` row.
- **Control**: `access.explain` for a role over a fixture snapshot; for a person through a stubbed IAM; the Zerops pin
  warning when the namespace's proxy source differs from the default.
- **Proxy answers**: a 403 carries `X-Request-Id` and its page shows it; the `deny` log line has `subject` on
  `insufficient_permission` and none on `no_credential`; `logging.test.ts` still finds no secret.
- **People counts**: a candidate role that adds an action raises "gain" by the holders of that role; a row whose
  callers change from `human` to `machine` with the same requirement counts every holder as a loss; the cap reads
  "500 or more"; an approver without `iam.admin` gets the groups without counts and Control makes no IAM call;
  `access.previewAudience` refuses a user administrator and Control's own keys.

## Slicing into PRs

1. **The simulator (S).** `@fabrika/proxy-core/simulate`, the in-memory gateway, placeholder paths, shadowing, the
   client scenarios, the reason sentences. Witness: the matrix-equivalence test and the scenario tests.
2. **Hypothetical roles in the console and MCP (M).** The providers' `proxyEntry` capability, Control
   `access.explain` for roles (a workspace for `dev`), the environment "Access" tab, the `explain_access` MCP tool and
   its row in `docs/reference/mcp-authoring.md`. Witness: the served-table tests per provider; Control use-case test
   over a fixture snapshot; the MCP tool list test.
3. **Real principals (M).** IAM `access.preview` on both engines with its gates; Control forwards the console bearer;
   the principal picker. Witness: the IAM preview tests on SQLite and Postgres; the gate tests.
4. **Refused-request reference (S).** `X-Request-Id` and the page reference on refusals, `subject` on the deny line,
   "Explain a refused request" in the console. Witness: proxy-core page and logging tests; the Cloudflare Worker
   composition test.
5. **People counts on the approval page (M).** IAM `access.previewAudience` with a candidate `RoleSource`, `iam.admin`
   only; Control `access.audience` over the approver's bearer; the counts beside each audience group for an
   `iam.admin` approver. Witness: the count test above; ADR-0050 §7's grouping
   test still holds (counts decide nothing).

Order: 1 → 2 → 3, then 4 and 5 in either order. PR 4's proxy half (the reference and the `subject` on the log line)
needs nothing and may land first; its console replay uses `access.explain` (2) and real principals (3). PR 5 needs the
simulator (1), `proxyEntry` (2) and IAM's permission sets beside the preview (3).

## Open questions

1. **A self view.** May any signed-in person ask "why was I refused" for themselves? Default: not in v1. It would
   show an application's endpoint table to every user of it, and the 403 page links nowhere by design.
2. **An application administrator.** Should the holder of an application's `members.manage`-style action (ADR-0022
   rule 6, `app_members`) preview its own people? Default: no; they keep `appPeople`, and the simulator stays with
   IAM administrators.
3. **Persisting refusals.** Default: no. Revisit if operators ask "who was refused" rather than "why was this one".
4. **Terminal sessions.** Default: out of scope; the answer says it assumes no terminal.
5. **ADR.** Default: no new ADR. Add a paragraph to ADR-0022 §3 that the simulator is a caller of the decision, never
   a second one, and to ADR-0050 §7 for the people counts.

## Decisions

- **People counts only for an approver who is also an IAM administrator** (review of 2026-11-04), through their own
  token. Control gets no new IAM credential.
- **Order.** PRs 1–3 are scheduled with the second wave, PRs 4 and 5 with the third: PR 4's console replay needs
  PRs 2 and 3, and its proxy half may land earlier when a slot is free.
