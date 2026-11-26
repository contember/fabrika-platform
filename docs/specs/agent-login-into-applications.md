# Agent login into applications

A person lets an agent or a script on their machine call one application environment as themselves. They approve it in
the browser with the device grant the command line already uses for Control and Operations
([`cli-device-grant.md`](../reference/cli-device-grant.md)). The grant is read-only unless the person picks `write`. The
proxy exchanges it for an ordinary application token of the person that names the agent, so the application keeps
every authorization check it runs for the person.

- **Size:** M overall (six PRs, none larger than M), about 14–20 h of agent time with review rounds and CI.
- **Depends on:** nothing built. Step 5 (protected environments) builds on the approval policy of
  [ADR-0083](../decisions/0083-an-environment-chooses-what-waits-for-approval.md).
- **Closes:** the token half of [backlog 267](../backlog/267-every-application-as-an-mcp-server.md). The MCP tool surface
  of that item stays open and can reuse this exchange.

## Problem

An agent that should read or change an application's data has no credential an application accepts except a `px_`
key:

- **The device grant reaches only Control and Operations.** Every resource IAM serves to the command-line client is
  Control's (`app: vozka`; `packages/control-contract/src/cli-access.ts:13-67`, written into `OAUTH_CONFIG` by
  `packages/iam/fabrika.config.ts:130-139` and `packages/installation-init/src/mcp.ts:164-178`). No application
  environment is a resource.
- **An application refuses an OAuth token at three layers.** An application row lists only `human`, `machine`, `link`
  and `app:<id>` callers (`packages/auth-core/src/contract.ts:147`); the caller `oauth` exists only for installation
  rows (`packages/auth-core/src/installation-endpoint.ts:12-17`, `packages/proxy-core/src/manifest.ts:264-266`). On an
  application row the proxy sends every bearer to the key exchange, which refuses one without the `px_` prefix as
  `invalid_key` (`packages/proxy-core/src/authorize.ts:385-395`, `:465-466`). The framework verifies with the audience
  `<app>@<env>`, whose profile refuses a token with OAuth claims (`packages/auth-core/src/token.ts:294-296`).
- **So an agent holds a key.** A key bound to the person who issued it presents caller `human` and carries the person's
  live permissions (`packages/iam/src/tokens.ts:430-440`, `packages/auth-core/src/requirement.ts:43-61`); a service key
  presents `machine`. Either lives up to 30 days (`MAX_KEY_LIFETIME_SECONDS`, `packages/auth-core/src/rpc.ts:184`),
  carries every action its principal holds, and nothing in its tokens says that an agent holds it. A person who will not
  hand an agent a month of their full authority gets a service principal instead, and the application gains a group
  that lists `machine` (`examples/app/src/notes/endpoints.ts:9`) or a second group of the same procedures for machines
  only. That group runs as a principal no person is accountable for, with roles granted to it by hand.

What is missing is the credential the console already has: narrow, short, approved in the browser, revocable, and
acting as the person.

## Design

### The shared client profile

The agent side uses only standards, so one client script works against this platform and against any other server that
serves the same profile. A parallel design for another application framework adopts the profile unchanged.

1. **Discovery from the resource alone.** The client starts from the resource URL, or from the `resource_metadata` of a
   `WWW-Authenticate: Bearer` challenge. It derives the protected resource metadata URL by RFC 9728 path insertion
   (`https://<host>/api` → `https://<host>/.well-known/oauth-protected-resource/api`), reads `authorization_servers[0]`,
   then that server's RFC 8414 metadata: `device_authorization_endpoint`, `token_endpoint`, `revocation_endpoint`.
   Every endpoint must be on the issuer's origin. The client follows no redirect while it discovers or calls.
2. **Device authorization (RFC 8628).** `POST device_authorization_endpoint` with `client_id=agent-cli`, `scope`,
   `resource` (RFC 8707) and optionally `agent_label` (below). The client prints `verification_uri_complete` and
   `user_code` on stderr and polls the token endpoint with
   `grant_type=urn:ietf:params:oauth:grant-type:device_code`, honouring `authorization_pending`, `slow_down`,
   `access_denied` and `expired_token`.
3. **The answer.** A short-lived bearer `access_token` whose audience is the resource, a single-use rotating
   `refresh_token` (presenting a spent one revokes the whole grant), and `scope`, what was granted.
4. **Use.** `Authorization: Bearer <access_token>`. Refresh with `grant_type=refresh_token` and the same `resource`.
   After an answer that did not arrive, the client never sends that device code or refresh token again; it starts a
   new grant.
5. **Ending.** RFC 7009 at `revocation_endpoint` with the refresh token ends the whole grant.
6. **Scopes.** `read`, the default when `scope` is omitted, and `write`. A server may serve more; the client needs only
   these two.
7. **Custody.** The refresh token goes to a git-style credential helper and nowhere else: `<helper> get` and
   `<helper> store`, with `origin=<resource origin>` and `refresh_token=<token>` lines on stdin, rotated under one lock
   file per origin, as [`cli-device-grant.md`](../reference/cli-device-grant.md) already does for the console.

`agent_label` is the one parameter outside the RFCs: the agent's own name for itself (at most 64 characters). RFC 6749
§3.2 has a server ignore a parameter it does not know, so a client may always send it. `agent-cli` is a public client
with no secret, the device and refresh grants only, served application resources alone. `fabrika-cli` stays the client
of Control and Operations, so neither client reaches the other's resources.

### An application environment is a resource

The resource is the origin of one application environment, `https://<host>`, with no path. IAM resolves it through the
return origins Control already registers for `<app>@<env>` (`app_return_origins`). Every sandbox host of a `dev`
environment resolves to that environment's one id, as its handoff does. There is no operator configuration: an
application environment is a resource exactly when the application's approved schema admits the caller `agent`
(below), which IAM records with the schema it reconciles. Any other origin is `invalid_target`.

The proxy serves the protected resource metadata on such a host at `/.well-known/oauth-protected-resource`, before it
selects an endpoint, as it serves `/__fabrika/auth/callback`:
`{ resource, authorization_servers: [<IAM issuer>], scopes_supported: ['read', 'write'], bearer_methods_supported: ['header'] }`.
On a host whose application admits no `agent`, the path answers 404. A refused bearer on a row that lists `agent`
carries `WWW-Authenticate: Bearer resource_metadata="https://<host>/.well-known/oauth-protected-resource"`.

A grant names exactly one resource. An agent that works on `stage` and on `prod` holds two grants, each approved on its
own; the credential helper keeps one refresh token per origin.

### The approval

IAM's device page (`packages/iam/src/oauth-device-page.ts`) gains the application case. Beside the code and the
lifetime it shows:

- the application's display name, the environment and the origin;
- the scope in words: `read` "reads what you can read, changes nothing"; `write` "acts as you, including changes";
- the agent's label, marked as the agent's own words, and the client.

The person approves with their IAM login (`session.app === null`, as `grantAuthority` requires,
`packages/iam/src/oauth.ts:321-326`). The lifetime choices stay an hour, a day or a week, and the grant ends no later
than the login that approved it. A `write` grant at a protected environment meets the environment's `agent-write` mode
(below). The page never offers more than was asked: a request for `read` cannot be turned into `write` on the page, and
a request for `write` may be approved as `read`.

The grant row (`oauth_grants`) adds the agent label. IAM writes `iam.oauth.grant.approve` and `iam.oauth.grant.revoke`
audit records with the grant id, the principal, the approving login, the client, the label, the resource, the scope and
the expiry. Today a device approval writes none.

### The exchange: the proxy turns the grant into the person's application token

On an application row, a bearer that is not a `px_` key goes to a new exchange instead of `invalid_key`:

```
proxy → IAM   mintFromGrant({ app: '<app>@<env>', resource: 'https://<host>', token, requestId })
```

It sits on the proxy's mint surface beside `mintFromKey` (`/auth/mint/*` on Zerops, the `IAM` binding on Cloudflare),
never on the `IamRpc` an application holds. IAM:

1. verifies the resource token (signature, `typ: at+jwt`, `aud` equal to `resource`, `oauth.app` equal to `app`,
   `client_id` `agent-cli`);
2. runs `grantAuthority` for its grant: not revoked, not expired, the approving login still usable, the principal an
   active user (`packages/iam/src/oauth.ts:321-326`). A revoked grant, an ended login or a disabled person fails here,
   at the next exchange;
3. reads the environment's `agent-write` mode for a `write` grant (step 5) and refuses one the environment refuses;
4. resolves the person's live permissions at `<app>@<env>`, as `mintToken` does for a session, and mints an ordinary
   application token: `aud` `<app>@<env>`, `ptype: 'user'`, `label`, `email`, the permissions, no `session`, and
   `act: { sub: 'agent-cli', grant, label?, scope }`. Its `exp` is the earliest of 300 s, the resource token's `exp` and
   the authority deadline.

The proxy caches the result per application and bearer digest, as it caches a key's token (`authorize.ts:469`, `:496`),
until 30 s before `exp`. A refused exchange is 401 with the challenge above, and never falls back to a session.

`callerOf` maps a user token that carries `act` to the caller `agent`, so the proxy's next step, "the caller must be one
of the row's callers" (`authorize.ts:345-347`), admits it only on a row that lists `agent`. Then:

- **Scope.** `read` admits only rows of kind `query` and `download`; `write` admits `query`, `mutation`, `upload` and
  `download`. Neither admits `spa`. A refused kind is 403 `scope`. Kind is already part of each row's digest, so the
  application, which repeats the decision, sees the same rule.
- **Requirement.** Unchanged: the token's permissions are the person's, so `satisfies` holds exactly where it holds
  for the person.
- **Admission.** Unchanged: a bearer is not session-authenticated and needs no `Sec-Fetch-Site`.

Why an exchange and not the resource token itself: the application then receives the token shape it already verifies,
and the resource token, whose audience is a URL, stays the only form an agent holds. A native application token never
becomes an external bearer, so an `X-Fabrika-Token` that leaks from an application's log still buys nothing at the
proxy.

### The application keeps every authorization check

The framework repeats the proxy's decision as authorization (ADR-0022 rule 5) with the same inputs:

- **Caller.** `presentedBy` (`packages/app/src/implement/principal.ts:97-99`) reads `act` and presents `agent`; the
  group must list it.
- **Scope.** A `read` token on a `mutation` row is refused before the handler. A `query` already runs its data access
  in a read-only invocation (`packages/app/src/implement/dispatch.ts:769`, Postgres `READ ONLY`), so `read` holds below
  the handler too.
- **The handler.** `ctx.principal` is the person, with the person's permissions; `.require`, `can()` and every table
  policy of the data layer decide as they do for the person. `ctx.agent` is `{ grant, label, scope }` when an agent
  calls, so an application that must keep something for the person in front of the screen leaves `agent` off that group,
  or checks `ctx.agent` in the handler.

The contract declares it per group: `app.group({ callers: ['human', 'agent'] }, …)`. `agent` is an `RpcCaller`, so it
reaches procedures only, never an SPA, a link mount, a form or an export. The approval diff already reports a caller a
row gains (`packages/control/src/approval/diff.ts:191`), so "gains caller `agent`" shows on the deploy that opens a group
to agents, and the access approval records it ([ADR-0050](../decisions/0050-approved-access.md)).

### Tenant and environment binding

- **Installation.** The issuer is the installation's IAM, and the proxy verifies against its JWKS only.
- **Application and environment.** The resource names one `<app>@<env>`; the resource token's `aud` and `oauth.app`
  name it again; the exchanged token's `aud` is it. A `stage` grant at `prod` fails all three.
- **Scope values inside the application.** Unchanged and live: the token carries the person's grants with their scopes
  as IAM resolves them at each exchange, so a person who loses a value loses it for the agent within 300 s.

### Lifetime and revocation

| Credential                      | Lives                                                    | Ends early when                                          |
| ------------------------------- | -------------------------------------------------------- | -------------------------------------------------------- |
| the grant (refresh token)       | an hour, a day or a week, never past the approving login | revoked (RFC 7009), sign-out, login revoked, replay      |
| the resource token              | 300 s                                                    | not before its `exp`; the next exchange checks the grant |
| the exchanged application token | earliest of 300 s, the resource token, the authority     | not before its `exp`; the proxy re-exchanges             |

So a revocation stops the agent within 300 s, the bound a session's or a key's application token already has
(ADR-0022 rule 4). A person lists and revokes their own grants on IAM's account page, and an IAM administrator anyone's
(step 6); until then the revocation endpoint, sign-out and an administrator revoking the login end them.

### Audit

- **IAM.** The grant's approval and revocation records above.
- **Application.** `IamRpc.audit` already verifies the caller's token to find the application
  (`packages/iam/src/rpc.ts:273-299`). It also reads `act` from that verified token, never from the event, and writes two
  new `audit_events` columns, `actor_id` (`oauth:<grant id>`) and `actor_label`. So an application's audit row says
  "agent `<label>` for `<person>`", and joins to the approval record that names who approved it and when.
- **The application's own history.** `ctx.agent` is available to a handler that writes its own record.

### Protected environments and approvals

[ADR-0083](../decisions/0083-an-environment-chooses-what-waits-for-approval.md) judges changes to an environment's
delivery and access: deploys, secrets, variables, data operations, registry rows and grants. An application procedure
is none of those, and this design adds no gate to procedures. It adds one action category, judged when a person
approves a `write` grant for an agent at a protected environment:

| Category      | Covers                                                   | Modes it takes  | Default (strict) | Permissive |
| ------------- | -------------------------------------------------------- | --------------- | ---------------- | ---------- |
| `agent-write` | a `write` grant that lets an agent act as a person there | `off`, `refuse` | `off`            | `off`      |

`plan` and `person` do not apply: the device page is already a person's decision on exactly this grant. `refuse` makes
the environment serve `read` grants only. The category's `stepUp` setting defaults to `webauthn` under strict, so the
person confirms a `write` grant at a protected environment with a passkey bound to the device attempt, once IAM's
step-up of ADR-0083 §8 exists. Control mirrors the mode and the setting into IAM with the provisioning key, as it
mirrors the `grants` mode (ADR-0083 §4). IAM reads the mirror at approval and at every exchange, so switching a
category to `refuse` stops existing `write` grants within 300 s.

Three consequences for ADR-0083:

- The exchanged token never reaches Control: its audience is the application. The agent keeps the console's grant
  for delivery work, and stays a non-person there (§6).
- An approval request is still Control's alone. An agent asks for a deploy or a secret with the console's grant, as
  before.
- §4 says that "an agent's own credential comes from the device flow and holds nothing at an application, so asking
  [a role] for itself is the common case". With an application grant the agent acts with the person's own roles, so
  asking a role for the person is no longer needed for that; `agent-grants` stays for service principals and for a role
  the person lacks. Step 5 rewrites that sentence.

### Migration away from machine-only groups

An application that added a `machine` group so that an agent could call it:

1. raises its framework pin to the release that knows `agent`;
2. adds `agent` to the groups the agent needs, usually the existing `human` groups (the deploy's approval diff shows
   "gains caller `agent`");
3. switches the agent from the service key to the device grant with `agent-cli`;
4. removes the machine-only group or the `machine` caller, and revokes the service key and its principal's grants.

`machine` stays for what has no person behind it: an integration, a nightly import from another system. The migration
guide of the release that ships `agent` carries these steps.

## API and contract changes

- **`@fabrika/auth-core`.** `RpcCaller` gains `agent`. `AccessTokenClaims.act?: { sub: string; grant: string; label?:
  string; scope: 'read' | 'write' }`, accepted by `buildAccessClaims` and `parseAccessClaims` only on a user token
  without `session` and without OAuth claims; the parser refuses it anywhere else. `callerOf` maps it to `agent`.
  `AGENT_CLIENT_ID = 'agent-cli'`, `AGENT_SCOPES`, and the kinds each scope admits (one statement the proxy and the
  framework read).
- **`@fabrika/proxy-core`.** The manifest parser accepts `agent` on an application row. `endpointCaller` sends a
  non-`px_` bearer on an application row to `exchangeGrant`; the scope check; the metadata path and the challenge.
- **IAM.** `mintFromGrant` on the mint surface; the built-in `agent-cli` client; application resources resolved from
  return origins and the schema's `agent` flag; the device page's application case; the label column on `oauth_grants`;
  the two audit records; `audit_events.actor_id` and `actor_label`; the `agent-write` mirror. Migrations on both
  engines.
- **`@fabrika/app`.** `callers: [..., 'agent']` on a group; `presentedBy` and the scope check; `ctx.agent`.
- **`@fabrika/auth`.** `AuthContext.agent?: { grant; label?; scope }`, from `claims.act`.
- **Control.** `agent-write` in `@fabrika/control-contract`'s categories, the console's modes page, and the mirror.
- **Dashboard and IAM's account page.** The person's grants, with revoke; the administrator's list.

**ADR-0062.** Additive. A framework release that declares `agent` needs a platform that knows it. Control reads a
contract with its own release's artifact schema, which refuses an unknown caller
(`packages/app/src/contract/artifact-schema.ts:171-172`), so the declaration cannot reach an older proxy. A platform upgrade
changes nothing for an application that does not declare `agent`: IAM serves its environments as no resource, and the
proxy never sends it a token with `act`. The `act` token reaches only a framework that declared `agent`, so no older
parser ever reads it.

## Security and permissions

- **One credential per request (ADR-0022 rule 3).** The agent sends only the resource token; the proxy replaces it with
  the exchanged token, as it replaces a key.
- **The one enforcement decision.** The caller and scope checks are steps of the proxy's existing decision in
  `@fabrika/proxy-core`; the framework repeats them as authorization. No second decision appears.
- **Never wider than the person.** Every exchange resolves the person's live permissions; the scope only removes
  endpoint kinds.
- **Read-only.** `read` reaches no `mutation` or `upload` row, and a `query` runs in a read-only transaction. A query
  can still have an effect outside the database (an outbound call, a mail); the kind is the author's promise, which the
  checker and the approval diff already see.
- **Device-code phishing.** The page shows the origin, the application, the environment, the scope in words and the
  agent's label as the agent's words; the default is `read`; an attempt lives 300 s; `write` at a protected environment
  takes a passkey under strict.
- **Custody.** The refresh token lives only in the helper; the proxy and the application see no refresh token and no
  device code. A leaked access token reaches one environment for at most 300 s.
- **Rate.** The device and token endpoints keep their per-client buckets; the exchange is behind the proxy's cache, one
  IAM call per agent and environment per few minutes.

## Rollout on an existing installation

1. **Generated files.** None change. Application resources come from return origins, not from `OAUTH_CONFIG`.
2. **Environment variables.** None added, renamed or removed.
3. **Provider state.** None. The IAM migrations (the label column, the audit columns, the mirror) are additive and run
   on `upgrade` (ADR-0017). Existing grants keep working; they carry no label.
4. **Floating pins.** None.

On Zerops `platform deploy` builds IAM first, then the proxy, then Control. An application can declare `agent` only
after Control accepts it, so no step of the roll sees a declaration its component does not know.

## Test plan

- `auth-core`: `act` builds and parses only on a user token without `session` or OAuth claims; `callerOf` gives `agent`;
  the scope table.
- `proxy-core`: a non-`px_` bearer on an application row is exchanged; a refused exchange is 401 with the challenge and
  no session fallback; `agent` on a row without it is 403; `read` on a `mutation` is 403; `write` reaches it; the cache
  key is the bearer digest; the metadata document on a host with and without `agent`.
- IAM, both engines: `mintFromGrant` refuses another resource, another application id, a `fabrika-cli` token, a revoked
  grant, an ended login, a disabled person and a refused `write`; the token carries the person's live permissions and
  `act`; the device page offers `read` for a `write` request and never the reverse; `invalid_target` for an origin of an
  application without `agent`; the audit records.
- `@fabrika/app`: a group without `agent` refuses the token; `read` on a mutation is refused before the handler;
  `ctx.agent` is set; a query writes nothing.
- End to end in the local stack (`tests/browser`): a script runs the shared profile against the example application,
  the person approves `read`, a query answers and a mutation is 403; a `write` grant mutates; revoking stops the next
  exchange.

## Step plan

| # | PR                                                                                                | Size | Agent time | Witness                                             |
| - | ------------------------------------------------------------------------------------------------- | ---- | ---------- | --------------------------------------------------- |
| 1 | `auth-core`: `agent`, `act`, the client id and the scope table                                    | S    | 1–2 h      | the claim and `callerOf` tests                      |
| 2 | IAM: `agent-cli`, application resources, the device page, `mintFromGrant`, the label, grant audit | M    | 4–5 h      | IAM tests on both engines                           |
| 3 | proxy: the exchange, the caller and scope checks, the metadata document and the challenge         | M    | 3–4 h      | `proxy-core` tests, the Caddy live chain            |
| 4 | framework: `agent` on a group, `ctx.agent`, `IamRpc.audit` actor columns, the example, the guide  | M    | 3–4 h      | `@fabrika/app` tests, the browser journey           |
| 5 | `agent-write` in the approval policy and its mirror; the ADR-0083 rewrite                         | S    | 2–3 h      | Control and IAM tests of the mirror and the refusal |
| 6 | the person's and the administrator's grant lists with revoke                                      | S    | 1–2 h      | a browser test that revokes a grant                 |

PRs 1–4 deliver the feature; 5 and 6 can follow in either order. An ADR on the decision lands with PR 4, and
`cli-device-grant.md` describes the application case with it. Waits on the user: none for the code; the merge of each PR
follows the usual review round.

## Open questions

- **`write` narrowed to fewer actions.** The page could let the person tick a subset of their actions for `write`, as a
  ceiling IAM applies at each exchange (`narrowPermissions`). Default: not in v1; the group's callers already bound what
  an agent reaches. The token answer's `scope` stays `write` either way, as in the shared profile.
- **`agent-write` default under strict.** `off` with a passkey, as above, or `refuse`. Default: `off` with a passkey;
  agents that replace a machine group write today without any person.
- **One `act` claim with agent task keys.** [Agent task keys](agent-task-keys.md) put `act` on a resource token to the
  console, refused on a native token; this design puts it on an application token. Neither is built (the task-key spec
  says its first slice is, but `packages/auth-core/src/token.ts` has no `act`). Default: one claim with a common core
  `{ sub, label }`, accepted in both places; whichever lands first defines the parser, and the audit columns
  (`actor_id`, `actor_label`) serve both.
- **The MCP surface of backlog 267.** Its tools could run on this exchange with an authorization-code client instead of
  `agent-cli`. Default: decided there, with its policy on application data reaching a third-party model.
- **Scope values.** A grant narrowed to one value of a dimension (`read:<dimension>=<value>`). Default: not in v1.
