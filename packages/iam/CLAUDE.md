# @fabrika/iam

The Access service: SSO and password login, session and `px_` credential custody, per-app token
minting, the administration API, and the audit log. It runs on **two** targets — a Cloudflare
`WorkerEntrypoint` and a long-running Bun process — from one shared body of code. Assumes the root
CLAUDE.md. Browser-safe admin DTOs live in `@fabrika/iam-contract`; the `IamRpc` contract, policy
evaluation, and token shapes live in `@fabrika/auth-core`.

## Commands (this package)

```bash
bun run dev                 # lopata dev on :18191
bun run oblaka              # regenerate wrangler.jsonc — never hand-edit it
bun run serve               # the long-running Bun server (src/node/server.ts)
bun run migrate:postgres    # apply migrations-postgres/
bun run prune:auth-log      # the cron one-shot (platform crontab drives this, not a timer)
bun test src/__tests__/entrypoint-isolation.test.ts   # the import-graph guard, below
```

## Two entrypoints, one body of code

|            | Cloudflare                                | Bun process                                      |
| ---------- | ----------------------------------------- | ------------------------------------------------ |
| entrypoint | `src/index.ts` (`cloudflare:workers`)     | `src/node/server.ts` (`Bun.serve`)               |
| `IamRpc`   | service binding on the `WorkerEntrypoint` | HTTP via `src/rpc-http.ts`, shared-secret gated  |
| membership | `PropustkaApplication` methods            | `src/membership-http.ts`, per-application key    |
| cron       | `scheduled()` → `runIamMaintenance`       | platform crontab → `src/node/prune.ts`           |
| migrations | `migrations/` (SQLite/D1)                 | `migrations-postgres/` via `src/node/migrate.ts` |

`src/app.ts` (routes), `src/rpc.ts` (the `IamRpc` object), and `src/cron.ts` are the shared layer and
import **neither** runtime. `src/index.ts` is the only file that may import `cloudflare:workers`;
everything under `src/node/` is the only code that may import `bun:*`/`node:*` or
`@fabrika/platform-node`. `src/__tests__/entrypoint-isolation.test.ts` walks both import graphs and
fails if that stops being true — it is the guard, not documentation of one.

## Invariants

- **IAM is served through its service contract, `src/service.ts`, and nothing else** (ADR-0022
  "Installation entries"). `createIamApp` is `serveService` over `iamServiceContract(iamServiceOptions(options))`:
  a switched-off transport (management `/rpc/*` with an empty `rpcKey`, mint `/auth/mint/*` with an empty
  `proxyKey`, the applications' `/membership/*`, liveness) has no row, and `/auth/mint` and `/rpc` are
  reserved, so none of its paths falls to a broader row. Every row is `protocol`, because IAM authenticates
  each surface itself, so no row requires `X-Fabrika-Endpoint` and the private hops (Control's
  `HttpIamRpc` and admin gateway) carry whatever header they carry. On Zerops the platform proxy publishes
  `IAM_INSTALLATION_SERVICE_OPTIONS`' table; IAM's Cloudflare Worker stays unfronted, and there the table is
  only its router. `src/service.ts` imports only `@fabrika/app/service`, so strict consumers can import it.
- **AN APPLICATION BINDS `PropustkaApplication`, NOT THE DEFAULT EXPORT** (`src/index.ts`). It carries
  what an application's Workers call — the proxy's `mintToken`/`mintFromKey`/`exchangeAuthCode`, the
  SDK's `getJwks`/`listPrincipals`/`audit`, and the `IamMembershipRpc` operations — and nothing else. The default `Propustka` extends it with
  `issueKey`, `revokeKey`, device approval, `fetch` and the cron, for platform components only;
  `@fabrika/provider-cloudflare` refuses an application binding to it. Adding a method to the narrow
  class gives it to every application on the installation.
- **AN ENTRYPOINT CLASS HOLDS NO GETTER AND NO FIELD.** workerd serves every member of the prototype
  chain over RPC, getters included, and pipelines into what they return: a `get rpc()` made
  `env.IAM.rpc.issueKey(…)` callable through any entrypoint, and a `get iam()` returned the signing
  keys. Each method builds its surface with the module function `iamRpc(this.env, this.ctx)`.
  `index.test.ts` lists both classes' members.
- **Only the SHA-256 hash of a credential is stored** (`src/secret.ts`), for API keys, share links,
  and SSO sessions alike. Plaintext is shown once at issue. Compare digests with
  `timingSafeEqualHex`, never raw secrets.
- **IAM NEVER PICKS THE HEADER ITS CLIENT COORDINATE COMES FROM** (`src/client-address.ts`). Behind a
  balancer its socket peer is the balancer, and a forwarding header a caller can write is worse than
  no limiter because it looks like protection (backlog 21, 49). So each composition root names the one
  header its own ingress overwrites — `CF-Connecting-IP` in `src/index.ts` (the Worker holds its own
  Custom Domain, so the hop in front of it is Cloudflare's edge), `X-Fabrika-Client-Ip` in
  `src/node/server.ts` (the Caddy proxy writes it after deleting the caller's) — and shared code reads
  that one and nothing else. **Naming none is supported and means no per-client bucket at all**, never a
  guess. Never name a header the ingress does not overwrite.
- **THE AUDIT CORRELATION ID FOLLOWS THE SAME RULE** (`src/request-id.ts`). The root names the header:
  `cf-ray` in `src/index.ts` (no proxy strips a caller's `X-Request-Id` in front of the Worker),
  `X-Request-Id` in `src/node/server.ts` (the proxy deletes and re-injects it). Naming none means a
  generated id. Any value — header or `IamRpc` `requestId` (`src/rpc.ts`) — must pass
  `acceptRequestId` (≤ 64 chars, `[A-Za-z0-9._:-]`) or it is REPLACED by a generated id, never
  truncated and never refused. No unvalidated caller string reaches `auth_log` or `audit_events`.
- **ON THE BUN ROOT BOTH HEADERS COUNT ONLY BESIDE THE PROXY'S SECRET** (`src/proxy-proof.ts`). IAM is not
  publicly routed, but anything on the platform project's private network can reach its port. So the platform
  proxy sends `X-Fabrika-Proxy-Secret` on IAM's route (the session owner's, from
  `FABRIKA_INSTALLATION_PROXY_SECRET_IAM`), and IAM holds the same variable. A request without a matching secret
  (digests compared in constant time) keys its client bucket on the one shared `UNPROVEN_CLIENT_ADDRESS` and gets
  a generated request id. **It is attribution, not an enforcement decision: a missing secret is never a refusal by
  itself**, though the shared bucket refuses once exhausted, as the balancer's one bucket does today. An unset variable turns the check off, so the Worker root, the local stack before a reset and an
  installation before the deploy that writes the secret behave as before. The console's admin hop through
  Control carries no secret, so its audit rows get a generated id. A short value fails the boot like the
  transport keys. The Zerops deploy derives the value from `FABRIKA_IAM_PROVISIONING_KEY` (ADR-0022 rule 5).
- **The per-client bucket decides admission from the RETURNING of the statement that increments it.**
  The account and deployment-wide buckets read first and record afterwards, which a concurrent burst
  walks straight through; that is tolerable for a key an attacker cannot pick, not for the one bucket
  whose job is to bound a burst. It counts every attempt (a decision taken before the work cannot know
  the outcome) and a successful login does not clear it — `clearLoginFailures` is the account key
  only, or one valid credential would zero the bucket between bursts.
- **A known-device cookie exempts a password login from the account and deployment-wide buckets, and from nothing
  else** (`auth/known-device.ts`, `Signer.signInternal`, audience `fabrika:iam:known-device`). It is
  `__Host-fabrika_device` (outside the `__Host-px_` prefix the Caddy proxy strips upstream), set only on a recorded password login, and exempts only a login for the principal it names. That
  login spends the device's own bucket instead (`password-login:device:<id>`, 10 / 15 min); once it blocks, the attempt
  is throttled as if no cookie were sent. The per-client bucket still applies. Those two buckets are keyed on a value
  anyone can pick, so without the exemption one client locks out a known account, or every password user on Zerops.
- **ONE MAILBOX RULE. `principals.email` is the NORMALIZED mailbox and nothing else; the spelling a
  human or an IdP used lives in `label`.** `PrincipalRepository` is the only place that applies
  `normalizeEmailIdentity`, so every caller may hand it any spelling, and every comparison is plain
  equality. Never ask the engine to case-fold an identity — SQLite's `LOWER()` is ASCII-only where
  Postgres's is full Unicode, so `LOWER(email) = LOWER(?)` used to make the BACKEND decide whether two
  addresses were one person. `principal_email_claims` is the second lock over the same rule and moves
  with a principal whose address changes. A user's token carries `principals.email` as its `email` claim
  (`mailboxClaim` in `src/tokens.ts`, on a session's and a user key's token alike), which an application reads as
  `ctx.principal.email` and mails; never put `label` there.
- **The OIDC flight cookie is signed AND `__Host-`** (`__Host-fabrika_oidc`; `Signer.signInternal`, audience
  `fabrika:iam:oidc-flight`). Its `state` cannot authenticate itself — whoever writes the cookie writes
  `state` too. The signature proves IAM issued the flight; the prefix proves this browser holds it, because
  a sibling host under a shared domain can toss in an attacker's validly signed flight under any other name.
  The callback never reads the legacy `px_oidc`. Every terminal outcome of `/auth/callback`, success or
  failure, clears both.
- **A handoff code is bound to the browser that started it.** The app proxy sends IAM an S256
  challenge and keeps the verifier in a host-only `__Host-` cookie. IAM integrity-binds the challenge
  into the hashed one-time code and requires the verifier during redemption. Consume the code before
  comparing the verifier: every redemption attempt remains single-use, including a wrong proof.
- **A proxy JWT proves identity across a first-party gateway, not IAM authority.** Control receives
  the short-lived app-audience token after the browser session stops at the proxy and forwards it as
  a bearer to IAM admin. IAM verifies its issuer and signed audience, then resolves the principal's
  IAM permissions live. Never authorize IAM from the token's calling-app `perms` snapshot.
- **ADMINISTRATION HAS ONE TRANSPORT. `/admin/*` REST IS A CLOSED PROVISIONING SURFACE.** Four
  operations: `GET|PUT /admin/apps/:app/schema` (a deploy's `reconcileSchema`, which runs outside
  the installation and has no service binding) and `POST /admin/api-keys` +
  `DELETE /admin/api-keys/:principalId` (the first machine caller, bootstrapped before a console
  exists). Every other `/admin/*` path is 404. About two dozen REST operations used to mirror
  `/admin/rpc` procedure for procedure with no caller at all, and each was a second place an
  authorization check could be forgotten (SEC-11) or an internal message could leak (CORR-4). Adding a route back means
  showing no `/admin/rpc` procedure can serve the caller — otherwise "policy, audit and
  hidden-object behaviour must not diverge by transport" becomes a property somebody has to
  maintain again. `extractCredentials`/`resolveAdmin` live in `admin/router.ts` and are shared by
  both, so the caller is resolved once.
- **`/admin/*` IS BEARER-ONLY.** `resolveAdmin` accepts a registered-audience proxy JWT (what
  Control's console gateway forwards as a bearer) or a `px_` key, and reads no session cookie. The JWT must be a
  signed-in session's (`AccessTokenClaims.session`): one the proxy minted from a `px_` key is 403 before any permission
  is resolved, because the key's grants narrow it and the live IAM permissions would not. Device approval
  (`device.ts` `human()`) applies the same rule, for the same reason. With
  no ambient credential there is nothing for a CSRF check to defend, so IAM keeps no admin-origin
  registry. A bearer request without an `Origin` passes; admission of a console session is the
  proxy's (`Sec-Fetch-Site`, ADR-0022 rule 3), before Control's gateway forwards it. A request with no bearer is
  401 in every environment — there is no credential-less local caller.
- **REVOKING AN IAM SESSION REVOKES EVERY APP SESSION DERIVED FROM IT, AND THAT IS A JOIN, NOT A
  SWEEP.** `getActiveSessionByHash`/`ById` join to `parent_session_id` on every lookup, so a child
  stops resolving the moment the parent carries `revoked_at` — its own row is never rewritten, which
  is why `sessions.revoke` is one statement and why a child can read `active` in `sessions.list`
  while its parent is dead. Never "fix" that by walking children: IAM cannot set a cookie on the
  hosts they belong to, and the walk would be the thing that races.
- **A SESSION IS USABLE ONLY WHILE THE INSTALLATION STILL ENABLES ITS METHOD.** `sessionUsable`
  (`src/auth.ts`) is checked at USE — at mint and at `currentSession` — because
  turning OIDC or password off changes what the NEXT login may do and nothing about the thirty days
  already issued. The local-dev bypass carries its own `authentication_method` (`local_dev`) instead of an
  exemption inside the predicate: a local composition runs OIDC off, so
  "refuse an `oidc` session when OIDC is off" would have disabled the bypass itself. Anything that
  seeds a session must therefore name a method that composition enables — `src/node/browser-identity.ts`
  seeds `password` for exactly that reason.
- **WHICH APP'S PROXY TOKEN MAY ADMINISTER IS A REGISTRY.** `ADMIN_AUDIENCES` (deploy
  var `FABRIKA_IAM_ADMIN_AUDIENCES`, comma-separated app ids) is the `aud` allowlist `resolveAdmin`'s
  JWT branch checks; unset means the console gateway's own app id (`vozka`), explicitly empty means
  no JWT may administer at all. It has to be registered because EVERY application receives the injected
  `X-Fabrika-Token` in cleartext, so an unpinned audience let any app replay an administrator's token
  against `/admin/rpc`, and nothing else stands in the way of a bearer. A malformed entry is refused
  at boot.
- **A `px_` CREDENTIAL IS BOUND TO AN APP.** `credentials.app` is what `resolveCredential` checks at
  every mint. It is REQUIRED on an anonymous credential (a share link): its inline grants are frozen
  at issue and were delegation-checked against one app, so without the binding authority granted at
  one app was spendable installation-wide. A principal-bound credential may be cross-app (`NULL`) —
  it carries no frozen authority and its permissions resolve per app through `grants`. An app
  mismatch is reported as `invalid_key`, never as a distinct reason.
- **AN API KEY'S PERMISSIONS ARE ITS SERVICE PRINCIPAL'S GRANTS, RESOLVED AT EVERY EXCHANGE.** Both provisioning paths
  (`apiKeys.provision`, `issueKey`'s service mode) write the principal, one grant and a credential with no inline grants,
  so `resolveCredential` reads the grants live. Editing a key is `grants.create`/`grants.delete` on its principal, an
  installation administrator's only (`requireGrantablePrincipal`), under the rules provisioning applies; the secret
  stays. A token minted before the change keeps its `perms` until it expires (`DEFAULT_TOKEN_TTL_SECONDS`, the
  proxy's cache included). A grant at an app other than the credential's binding never reaches the key's token.
- **EVERY KEY `issueKey` WRITES EXPIRES, AT MOST 30 DAYS OUT** (`MAX_KEY_LIFETIME_SECONDS`,
  `@fabrika/auth-core`), in all three modes — service, standalone, self-bound. A self-bound key
  carries the issuer's live permissions, so without a bound a 300-second access token could mint a
  permanent credential from itself; a service key is a new principal and a share link frozen
  authority, and neither may outlive the bound either. 30 days is the longest any current caller
  asks for (the builder's device-authorized key; `fabrika control key issue` requires
  `--expires-in`). The device repository caps its keys with the same constant.
- **A KEY LISTS EXACT ACTIONS OF ITS APP'S CATALOG, NO WILDCARD.** `issueKey` refuses `*` and
  `prefix.*` in every mode and requires each action verbatim in `app_actions`, before delegation —
  so an issuer holding `*` still cannot mint a key for an action the app never declared, and a key
  never grows when the app declares more. (Policies and grants keep their pattern rule; that is not
  this.) No current caller issues a wildcard key: the builder's device keys are written by the device
  repository with exact actions, and the CLI passes the operator's list. An expiry or action refusal
  is `not_allowed` over RPC and a 400 naming the problem on the admin share-link path
  (`IssueOutcome.problem`).
- **A WORKLOAD KEY CARRIES EXACTLY WHAT THE SCHEMA DECLARES FOR ITS WORKLOAD (ADR-0022 "Principal kinds").** A job,
  webhook or public procedure principal (kind `public`, named by its full endpoint id, ADR-0063) is a `service` row (`external_id` `workload:<app>:<kind>:<name>`) with a `workload_principals`
  row naming its kind; a token minted from its key has `ptype` = that kind and `workload` = its name.
  `resolveCredential` resolves it to the actions of its `app_workloads` row (written by the schema reconcile from
  `AppSchema.workloads`, contract applications only, exact catalog actions), app-wide, and to nothing without one. A
  reconcile that drops a workload revokes its keys in the same batch. A `public` workload needs at least one action,
  and the reconcile refuses a schema in which any application role grants one of its actions, so a role change cannot
  widen what anyone may cause.
- **A WORKLOAD PRINCIPAL RESOLVES NO GRANT ON ANY PATH, AND HOLDS NONE.** The one grant read every permission goes
  through, `getActiveGrantsForApp`, excludes workload principals in its SQL; `createGrant` and
  `createRoleGrantUnlessHeld` throw `WorkloadGrantError` for one, and `grants.create` answers 409 before anything else.
  A workload token is refused before any permission is resolved: by `resolveAdmin`'s token branch, by `resolveCaller`
  for every management and membership operation. The one exception is `resolveLinkCaller`, for `issueLink` and
  `revokeLink` only: it admits a **job**, which `membership.ts` then holds to its current declaration
  (`app_workloads.issues`, reconciled from the approved artifact's `issues`): it issues only links of that mount,
  with its declared actions app-wide (never more than its token carries), and revokes only links it issued of that
  mount. Without the declaration, for another mount, another app, and for every webhook, public or connector token, the answer
  is a refusal. `createLinkCredential` inserts a job's link only while the job's whole checked declaration still holds. An
  issuing job is app-wide for its mount: the link is bound to one object, the job is not. `apiKeys.list`, `get`,
  `rotate` and `revoke` do not see workload principals.
- **AN APPLICATION WITHOUT A BINDING CALLS `/membership/<method>`, AND ITS KEY ONLY PINS THE APPLICATION** (ADR-0022
  rule 6, `src/membership-http.ts`, mounted by the Bun composition only). The bearer is the environment's membership
  transport key (`membership_transport_keys`, hash only, no `credentials` row, so no `px_` path finds it and it mints
  nothing); a call whose `app` is not the key's is `not_allowed` before the operation runs. It serves `createScope`,
  `assignMember`, `revokeMember`, `listMembers`, `listAppMembers`, `findMember`, `issueLink` and `revokeLink`, never `requestDelegation`: only the
  proxy obtains a grant. The caller is still the token in the body. `membershipKeys.issue` (admin RPC) issues a key
  for an `<app>@<env>` id only, ≤30 days, and deletes every other key of it except `keep`; a reconcile that leaves the
  app no delegated endpoint, no link mount, no dimension that lists its members and no people of its own
  (`app_members`) deletes its keys in the same batch (the schema holds no per-endpoint list fact, so a
  members-declaring dimension keeps the key).
- **`workloads.issueKey` NEVER REVOKES THE KEY THE CALLER NAMES AS ACTIVE.** It creates the principal on first use,
  issues a key of at most 30 days, and revokes every other key of the workload except `keep` (the credential id
  Control has recorded). A key issued by an attempt whose record failed is therefore an orphan the next issuance
  revokes, and the running version's key stays valid until Control records its replacement.
- **`POST /auth/workload/token` IS PUBLIC, SO ITS COST IS BOUNDED BEFORE ANY LOOKUP** (`src/workload-token.ts`). In
  order: the body `{ app }`, the key's exact format (`px_` + 27 base64url characters), the per-client bucket of the
  password and device routes (`recordLoginFailure`, only where the composition names a client address; none
  otherwise, never a guess; 429), one lookup by the key's hash. `mintFromWorkloadKey` checks the kind and the app
  before it reads anything about the principal, so an absent, revoked, expired, disabled or non-workload key all
  answer the same `invalid_key`. A refusal writes no auth-log row; refusals are one aggregated warning per minute. A
  storage failure is a 503, never a refusal.
- **AN APPLICATION TOKEN CARRIES ONLY THE GRANTS OF ITS OWN APP ID (ADR-0022 rule 6).** Every
  permission question goes through `resolvePermissionsAt` (`src/resolve.ts`): a cross-app (`NULL`)
  grant and the bootstrap `admin` reach a token only when the app is a PLATFORM AUDIENCE
  (`Config.platformAudiences`: `propustka`, `vozka`, `operations`, plus every `ADMIN_AUDIENCES` entry).
  An application's id is `<app>@<env>` (`appEnvironmentId`, `@fabrika/auth-core`), so a grant, role or
  key of `notes@stage` never reaches `notes@prod`. The registry is separate from `ADMIN_AUDIENCES`
  on purpose: Operations is a platform service, not an admin gateway. Never resolve permissions with a
  hand-rolled grant query — the admin views and the delegation checks call the same function.
- **AN APPLICATION ISSUES NO CREDENTIALS.** `issueKey` and `revokeKey` answer `not_allowed` to every
  caller whose verified app is not a platform audience, the provisioning key included, on the binding
  and over `/rpc/*` alike (one `createIamRpc` object serves both). So does `listPrincipals`: an
  application lists the members of one value with `listMembers`.
- **A CONTRACT APPLICATION LISTS EXACT ACTIONS ON EVERY WRITE PATH (`src/contract-rules.ts`).** A
  schema reconciled with `contract: true` (`contract_apps`, written in the reconcile's own batch) makes
  IAM refuse a wildcard in its roles (`appSchemaSchema`), custom policies, grants — inline or through a
  role, the built-in `admin` included — provisioned keys and device keys. The device exchange
  writes its grant by raw SQL (`repositories/device.ts`), so the rule is checked at approval, again
  at exchange, and inside the issuing batch's claim, which matches no row for a wildcard key of a
  contract application. A
  role declared with `member.scope` (`roles.member_scope`) is granted only in a value of that scope
  dimension, never globally — in EVERY app, contract or not. A cross-app grant is not checked: it
  reaches no application. Declaring a role a membership role while it has a grant outside its
  dimension is a 409 naming the grants, and a guard statement in the reconcile batch rolls it back if
  one was written after the check. Resolution is the third lock: such a grant contributes nothing.
- **AN EXTERNAL PRINCIPAL HOLDS ONLY GRANTS OF A ROLE ITS APPLICATION DECLARES EXTERNAL (ADR-0051).**
  `principals.affiliation` is `internal` (every service, every row before migration 0012) or `external`;
  `roles.external` is 1 only on a reconciled membership role (both `CHECK`ed). Three locks, like `member.scope`:
  every grant write carries `eligibleGrantSql` in the statement that writes (`repositories/grants.ts`, and the
  membership repository's assignment, acceptance and scope creation), after `externalGrantProblem`
  (`src/contract-rules.ts`) names the reason — so no inline permissions, custom policy, built-in role or cross-app
  grant for an external (on Postgres the condition holds the role row `FOR SHARE` to commit, which a reconcile's
  rewrite of the row waits for, and an acceptance rolls back if its grant writes nothing); an external issues only a
  self-bound key (`issueKey`, `credentialStatements`' guard, device approval and claim); a reconcile that declares a
  role not external while an external holds it is a 409 naming the grants, plus a guard statement in the batch; and
  `computePermissions` drops such a grant, and gives an external no bootstrap `admin` and no cross-app grant. OIDC never claims or creates an external principal: `resolveUserPrincipal`
  refuses it (`oidc_external_principal`), `claimInvitedUser` matches only an internal row, and the allowlist's
  known-principal bypass admits only an internal one. Only `principals.promote` (installation admin, audited) makes one
  internal, and it revokes the principal's sessions and spends its pending password actions in the same statement
  group (`promoteToInternal`): promotion widens what it reaches, a bootstrap mailbox to installation admin. No demotion.
  On Postgres every transaction that writes more than one of a principal's rows among `principals`, `password_accounts`,
  `password_credentials`, `password_action_tokens` and `sessions` locks the principal row first
  (`principalLockStatements`): `promoteToInternal`, `upsertCredential` (enrollment and login rehash), `disableCredential`,
  `completeAction` and action-token issuance. They wait at one row and never hold each other's; a new such writer must
  start there too. So does every write that removes a grant: its first statement moves `principals.grant_revision`
  on (`grantRemovalStatement`, `repositories/grants.ts`) — the admin `grants.revoke`, a membership revoke, a delegated
  revoke and every repository delete. The one exception, an API key's revoke, disables the principal in the same statement.
- **MEMBERSHIP IS EVALUATED BY IAM, AGAINST THE CALLER'S LIVE PERMISSIONS (`src/membership.ts`).**
  Every `IamMembershipRpc` operation resolves the caller from its own credential and never grants it
  more than that credential carries: a `px_` key is resolved live and downscoped by its own grants, and
  a token's `perms` (up to five minutes old) count only where `resolvePermissionsAt` still holds them —
  so a token minted from a read-only key stays read-only. An
  anonymous credential, a share link included, is never a member caller; a service principal creates
  no scope and manages no member (`userOnly`), which closes "a public procedure plus a job that invites the
  submitted email". Membership is ordinary role grants scoped to a value (compatible with backlog 91);
  a value is checked as itself, flat — "there" means that exact `(type, value)`, global grants included.
  Assigning needs the dimension's `members.manage` there, a role that the target role's `assignableBy`
  names, and every action of the target role there; revoking needs the same for every role it removes.
  `assignableBy` names membership roles of the same dimension or application-wide roles (no `member`, never a
  built-in); the assigning role counts held in that value, or for an application-wide role also as a global
  grant (`listAssigningGrants`, `ASSIGNING_GRANT` in `repositories/membership.ts`), so staff with a global
  role invite into any value. An external never holds an application-wide role, so it never assigns this way.
  A built-in role key (`BUILTIN_ROLE_KEYS`, `admin`) is never a membership role: the
  schema parser refuses it, and scope creation also applies `contractGrantProblem` to the creator role.
  Repeating an assign or a revoke answers the same result — an active grant is kept, an expired one is
  renewed in the same statement (backlog 82's 409 stays for
  the admin grant API). `listMembers` needs `members.list` there and shows ids and roles (an
  application's member directory); labels only to `members.manage`, or to `members.list` too where the dimension
  declares `directory: 'labels'` (`app_scopes.members_directory`) — a user's label spells its address; emails, last
  sign-ins and open invitations only to `members.manage`. A last sign-in is per application: the child session a
  handoff redemption opens writes `app_sign_ins` in its batch (`createSession`), never pruned with `auth_log`. `findMember` answers ONE principal for an endpoint on, in or below the
  dimension, from nothing the application asserts: the action must be one of the dimension's `lookups` (reconciled
  from the approved contract's `directories`, `app_scopes.members_lookup`) and the caller must hold it on the scope
  itself; IAM knows no containment below a value, so a grant on a contained object never counts. The answer is the
  member (label by the same rule) or `null`, the same for an unknown id.
- **AN APPLICATION'S OWN PEOPLE ARE ADMINISTERED BY ITS OWN ADMINISTRATOR, AS AUTHORIZATION, NOT ENFORCEMENT**
  (`src/admin/app-people.ts`, ADR-0022 rule 6). `app_members` (reconciled from the vocabulary's `members` and
  `directory`) names the action that manages and the one that lists the principals holding any role of the app
  (`APP_MEMBER_GRANT`: a membership role only in a value of its dimension, an external's only of an external role).
  `listAppMembers` needs `list` held globally and pages by principal id (`MAX_APP_MEMBERS_PAGE`); labels by
  `directory` or to `manage`, emails and last sign-ins only to `manage`. The `appPeople.*` procedures of `/admin/rpc`
  are one of the two exceptions to "every procedure requires `iam.admin`" (`admin-rpc-gates.test.ts` names both): a USER behind
  a session's console token (`AccessTokenClaims.session`, set only by `mintToken`; never a `px_` key, presented or
  exchanged by the proxy, whose own grants narrow it) holding `manage` globally at the app, resolved
  live there, grants and revokes the app's declared global roles (no `member`, no built-in, no custom policy) whose
  every action it holds globally, to a person IAM already has — never an invitation, which would let an application's
  administrator create a principal the OIDC allowlist's known-principal bypass admits. An app it does not administer
  and an unknown app are one 404. Each change writes `iam.grant.create`/`iam.grant.revoke` under the APP, in its own
  transaction, with `delegated: true` and no address, and only under the `DelegatedAuthority` its check read (the
  user's `grant_revision` and the app's schema revision, read first; principal rows first, then the revision row
  `FOR SHARE` on Postgres); a stale one writes nothing and answers 409.
- **A USER ADMINISTRATOR MANAGES THE PEOPLE OF APPLICATIONS AND STOPS AT THE INSTALLATION** (ADR-0058,
  `src/admin/user-admin.ts`). IAM's vocabulary is `IAM_APP_SCHEMA` (`@fabrika/iam-contract`), reconciled under
  `propustka` beside the console: `iam.admin`, `iam.users.manage` (global, or in `app` values `<app>@<env>`) and the
  `user-admin` role. `administrationOf` turns the caller into an `Administration` on `AdminContext`: `installation`
  for `iam.admin`, `users` for `iam.users.manage` held from a SIGNED-IN SESSION only (never a `px_` key, as for
  `appPeople`). The procedures in `USER_ADMINISTRATION` (`__tests__/helpers/admin-router.ts`) carry no `.require`;
  `context` refuses a caller without an administration. For a `users` caller: a grant write (`grants.create`,
  `grants.delete`) only at a registered app that is not a platform audience and is in its scope, never cross-app
  (`requireManagedApp`), never on a service principal, whose grants are an API key's (`requireGrantablePrincipal`),
  and with no "holds what it grants" rule, because nothing granted there reaches the
  installation; an action on a principal (`principals.update`, `sessions.revoke`/`sessions.revokeAll`, `passwords.*`) only when every active
  grant of that principal is one it could have written, and never on a service or a bootstrap mailbox
  (`requireActableTarget`). Without an email sender it receives no manual password URL: an enrollment or a reset
  answers 403, and only `iam.admin` receives one (`passwordDelivery`). Reads (`principals.list/get`, `sessions.list`, apps, roles, policies) are installation-wide
  (backlog 175). `apps.list` marks each platform audience `installation: true`. `user-admin.test.ts` is the witness, on
  both engines.
- **A MEMBERSHIP WRITE SPENDS A DELEGATION GRANT** (`delegation_grants`, ADR-0022 rule 6). IAM issues
  one only to a user principal, only for an endpoint the schema lists under `delegations`, bound to the
  caller, the endpoint and the request id, for `DELEGATION_GRANT_TTL_SECONDS`. It is consumed BEFORE
  its binding is compared, like a handoff code, and the endpoint's purpose and dimension are read from
  the schema again at use. One grant serves one operation, so a request makes one membership write.
  `listMembers`, `findMember` and the link operations take none: they spend no membership authority.
- **THE LAST CREATOR STAYS.** `createScope` records the value in `membership_scopes` and grants the
  creator role in one batch; a revoke removes a creator grant only while another principal holds the
  role there. Its batch first creates the value's `membership_scopes` row on demand (an administrator
  may have granted the role without `createScope`), then locks it with a row-locking UPDATE — the one
  lock statement both dialects share; D1 runs a batch serially anyway — so two concurrent revokes of
  the last two holders serialize (`membership-postgres.test.ts` fails without the lock).
- **AN INVITATION IS ACCEPTED ONLY BY THE OWNER OF THE INVITED MAILBOX.** Assigning by email always
  opens an invitation, also for an address a principal already has; IAM mails a one-time link
  (`#token=`, never in a log) and stores its hash. `/auth/invitations/accept` accepts it, same-origin,
  for the principal signed in on IAM's host whose normalized `email` equals the invitation's — the
  token proves the mailbox, the session the principal. The inviter's authority is checked again at
  acceptance against the declarations of one schema revision (`app_schema_revisions`, read BEFORE the check; every
  reconcile and custom-policy write increments it as its first statement), and the UPDATE that consumes the invitation
  writes only while that authority still holds (`checkedAuthority`, `InviterCheck`): the inviter not disabled, the
  revision unchanged, the inviter's `grant_revision` the one read before its live permissions (so the removal of ANY of
  its grants, one that only supplied an action of the role included, is seen), and its assigning grant in the value or
  global. On Postgres the batch first locks the inviter's
  principal row, then the revision row, both `FOR SHARE`, and the conditions then hold the assigning grant and the
  role row `FOR SHARE` (principal first, as every writer of a principal's rows starts); a D1 batch runs alone. A
  removal, a disable or a reconcile either commits first and the acceptance is `not_allowed` with the invitation still
  open, or waits until the acceptance committed. The guarded UPDATE stamps a fresh `acceptance_id`, and the grant is written in the same
  batch only for the attempt holding it — never on a timestamp a replay can share. Without an email service, an invitation is `invitations_disabled`; assigning an existing
  principal by id still works. Invitations live `INVITATION_TTL_SECONDS` (7 days). Every acceptance names the token's
  hash in its guarded write, so a resend (`invitation.resend`, `rotateInvitation`: a new hash and a new 7 days) ends the
  old link even mid-submission. An invitation's `company_label` and `message` are plain text, bounded by
  `invitationOptionsProblem` (`@fabrika/auth-core`), and reach the e-mail as `{{companyLabel}}`/`{{message}}`.
- **AN INVITATION CREATES A PRINCIPAL ONLY AT ACCEPTANCE, AND ONLY AN EXTERNAL ONE WITH NOTHING BEFORE IT** (ADR-0020,
  ADR-0051, `invitationOffer`, `acceptCreatingPrincipal`, `MembershipRepository.acceptAsNewPrincipal`). The offer is
  `create` only for an open invitation whose role is declared external, with password and e-mail enabled, a mailbox no
  principal holds and `organizationMailbox` does not name (a bootstrap admin, an exact `HUMAN_EMAILS` entry or a
  `HUMAN_EMAIL_DOMAINS` domain; `*` names nobody), and an inviter that can still give the role; then the accept POST
  without a password answers the set-password form and changes nothing. Its POST with the password writes in ONE batch,
  principal row first: the `external` principal (label = the invited mailbox, activated), its mailbox claim, the guarded
  acceptance, the grant, the enabled password account and verifier, and three records (`iam.principal.create`,
  `iam.member.accept`, `iam.password.enrollment.complete`). After the inviter's and the revision's locks, the principal
  INSERT carries the open invitation under this token hash, the same checked authority as the acceptance and the role's
  `external = 1` (`FOR SHARE` on Postgres), so a refusal writes nothing; a guard statement rolls the batch back if the principal ended without its grant. A mailbox claimed
  concurrently fails the unique mailbox and rolls back too (`account_exists` → sign in and accept), so two acceptances
  create one principal. Then the IAM session (`invitation_enrollment`) and the 302 to `landingUrl`. A browser signed
  in on IAM as anyone gets neither the form nor the creation (409, the invited address, sign out or another browser
  profile): the new session would replace its cookie silently while its applications keep the old identity. An existing
  principal, disabled or with password disabled included, never gets a password from an invitation. An assign to an
  external role for a mailbox `organizationMailbox` names is `internal_mailbox` before anything is written.
- **A SHARE LINK IS BOUND TO ITS MOUNT AND ITS CHAIN** (`credentials.link_mount`, `link_dimension`,
  `link_chain`). `issueLink` checks the chain against the schema's containment, requires an expiry of
  at most the mount's `maxDays`, and requires the issuer to hold `issuedBy` and every granted action on
  some link of the chain; the grants are frozen on the object. Its token carries `link: { mount, chain }`
  and no `ptype`, and the framework re-checks the chain per request. `createLinkCredential` locks the
  mount row and inserts only while the schema still declares exactly what was checked (`CheckedLinkDeclaration`: the
  mount's dimension, grants, `issuedBy` and `maxDays`, the chain's containment, and an issuing job's actions and
  `issues`), so a reconcile in between either makes the write insert nothing (`not_allowed`) or comes after the
  committed key, which it revokes if it removes or moves the mount. The issuer or a holder of
  `members.manage` on a value of the chain revokes it (a job only as its issuer); a reconcile that removes the mount, or moves it
  to another dimension, revokes its keys in the same batch.
- **The admin router percent-decodes its path segments** (`decodedSegments`): an application id
  `notes@prod` arrives as `notes%40prod`, and registering the encoded spelling would create a second app.
- **IAM SIGNS NO ACCESS TOKEN ABOVE `MAX_ACCESS_TOKEN_BYTES` (8192, from `@fabrika/auth-core`).** The proxy
  forwards the token as one header and Bun, the application runtime on Zerops, refuses more than
  16 KiB of headers per request. Every bearer passes `boundedToken`: both mint fronts answer
  `token_too_large`, a decided refusal the proxy turns into a 403 — never a login bounce, because a
  new login mints the same token — and the OAuth code exchange and refresh answer `invalid_grant`.
- **`revokeKey` ACTS ONLY ON A CREDENTIAL OF THE CALLER'S VERIFIED APP.** Any other credential,
  including a cross-app (`app IS NULL`) one, is `not_found` — the answer for an unknown id — so one
  app can neither end nor probe another app's keys.
- **`audit` RECORDS THE APP OF THE CALLER'S VERIFIED TOKEN, NEVER ONE THE EVENT NAMES.** `AuditInput`
  has no `app`; it carries the proxy-injected token, and `verifiedTokenApp` (`src/auth.ts`) reads a
  native token's `aud` or a resource token's signed `app`. Signature, issuer and token kind are
  strict; only `exp` gets `AUDIT_TOKEN_EXPIRY_GRACE_SECONDS` (1 h), because a request authenticated
  before its token expired may finish after it, and this decides where an event is filed, never what
  is allowed. Every authorizing verify stays strict. A token that does not verify drops the event
  with a warning. The principal fields are still the caller's word.
- **A mutating auth route requires `sameOrigin`, `/auth/logout` included.** The session cookie is
  `SameSite=Lax`, so a cross-site top-level GET carried it; GET renders a confirm form, POST acts.
  Every 302 out of `src/auth/**` carries `cache-control: no-store` — those are the responses holding
  the session cookie and the single-use handoff code.
- **EVERY IAM-OWNED CHANGE WRITES ITS `audit_events` ROW IN THE CHANGE'S OWN TRANSACTION** (`repositories/audit.ts`).
  A use case builds the record (`adminEvent`, `memberEvent`, a login's or a principal's own event) and hands it to the
  repository that makes the change, or composes several repositories' builders into one `audit.commit([...])` or
  `audit.writer.run([...])`. A failed insert rolls the change back; never write a change's record afterwards or in
  `waitUntil`. This covers OIDC principal creation, claim and refresh, password completion and rehash, every password
  action token (an admin's or a public recovery's, the enrollment opt-in in the same batch), OAuth grant consent and
  revocation, and a workload's first key, whose principal is created in the key's batch. Out of scope, as transient
  single-use secrets or flow state that grants nothing by itself: delegation grants, handoff codes, OAuth codes and
  refresh tokens, device-flow steps before the claim (the claim writes `iam.credential.create`), login throttles, and
  the retention prunes.
- **A GUARDED CHANGE IS RECORDED FROM WHAT IT CHANGED, NEVER FROM AN EARLIER EXISTENCE CHECK** (`AuditWriter`). Its
  SQL is a `SqlChange` ending in `RETURNING`. On Postgres the change and its record are ONE statement,
  `WITH c0 AS (<change>) INSERT INTO audit_events … WHERE EXISTS (SELECT 1 FROM c0)`, because another writer (an admin
  grant beside a membership one, a login beside a bulk revoke) can invalidate any check read before the change. SQLite/D1
  serializes writers, so there `INSERT … WHERE changes() > 0` right after the change is exact. The dialect is the
  composition's (`createIamRepositories(db, {}, dialect)`; `createPostgresIamRepositories`); a repository built
  without one assumes SQLite and fails loudly on Postgres (`changes()` does not exist there). A no-op — a held role, a
  revoked session, a disabled principal, a bulk revoke with nothing left — writes no row. A role revocation writes
  one row per role it removed. `writeAuditEvent` alone is only for rows that record no change of IAM's: an
  application's `audit` event, an admin's access, a failed email delivery. `IamRpc.audit` stays best-effort
  (backlog 71).
- **AN AUDIT ROW HOLDS NO EMAIL.** `principal_label` is `auditLabelOf(principal)`: a user's id (its label spells its
  mailbox), a service's key name. No metadata names an address. Application events through `IamRpc.audit` carry the
  application's own label.
- **A LOGIN, A REFUSED LOGIN AND A LOGOUT WRITE `auth_log` BEFORE THE ANSWER.** `createSession` takes the login's row and
  `revokeSessionByHash` writes the `logout` row from the session it ends, each in the session's batch; a refused
  password, OIDC, handoff or local login goes through `refuseLogin` with a fixed `LoginRefusal` reason, never what
  the caller submitted. A row that cannot be written answers 503 and opens or ends no session. A login of a principal
  holding `iam.admin`, or `iam.users.manage` in any scope, at IAM is `privileged = 1`. A handoff redemption writes its `allow` row in the child session's
  batch. Token-only mint rows (`mintToken`, `mintFromKey`, the workload token) and a refused redemption open no
  session and stay in `waitUntil`.
- **EVERY `/admin/*` REQUEST OF AN ADMINISTRATOR WRITES ONE `iam.admin.access` ROW BEFORE IT RUNS** (`admin/access.ts`),
  reads included: method, route template, and for `/admin/rpc` the procedure (a well-formed name, else null), under
  the app the admin's credential was verified for (the console gateway, or `propustka` for a `px_` key). A request whose
  access cannot be recorded answers 503 and does not run. A refused REST route is recorded too: a 405 under its
  template, a path that names no operation under the fixed `/admin/*`, never the raw path. An administrator is an
  installation admin or a user administrator (`administrationOf`). An RPC caller with neither reaches no procedure but
  `appPeople.*`, and is not recorded; each change it makes there is. A mutation therefore writes two rows: the access and the
  change.
- **RETENTION IS AN IAM SETTING, IN DAYS** (`src/retention.ts`, `Config.retention`): `AUTH_LOG_RETENTION_DAYS` (deploy
  var `FABRIKA_IAM_AUTH_LOG_RETENTION_DAYS`, default 30) and `AUDIT_RETENTION_DAYS` (`FABRIKA_IAM_AUDIT_RETENTION_DAYS`,
  unset keeps every audit row). Anything but a whole number of days from 1 to 99999 fails the boot, in
  `buildServices` and in `node/runtime.ts`.
- **`Origin: null` IS the same-origin case here, and `Sec-Fetch-Site` is what proves it.** Every page
  this service renders sets `Referrer-Policy: no-referrer`, under which Fetch serializes a form POST's
  origin as `null` and sends no `Referer` — so comparing `Origin` against the issuer refused EVERY
  form on the service (login, enrollment, reset, forgot-password, logout) in a real browser, while
  every unit test passed because it wrote `Origin: <issuer>` by hand. `Sec-` is a forbidden header
  prefix, so `Sec-Fetch-Site` is the browser's word and not the page's, and `cross-site` is already
  refused before the origin is read. Never "simplify" this back to an unconditional URL comparison.
- **THE LOGIN PAGE'S `form-action` MUST NAME THE HANDOFF DESTINATION.** Chromium applies `form-action`
  to the REDIRECT a submission answers with, not only to its action, so `'self'` alone silently blocks
  the 302 to `<app>/__fabrika/auth/callback` — the login succeeds, a code is issued and spent, and the
  browser never leaves the form. `loginDestinationFields` widens the directive by exactly one origin, and
  that origin comes from the REGISTERED return URL, so widening the CSP can never widen where a
  browser may be sent. The account question (`chooseAccountPage`) takes the same origin. A page rendered for no handoff stays at `'self'`, unless it has no return address
  either and lands on the console, whose registered origin it then admits. The set-password and
  invitation-password pages widen it the same way, by the one registered origin the completed action lands on
  (`actionLandingOrigin`: the application's, else the console's), and so does the sign-out confirmation that
  lands on the console; each stays at `'self'` when it lands on IAM. Every widening origin is one `normalizeOrigin`
  admitted, and it refuses a host carrying `;`, `,`, a quote or `*` — the URL parser keeps them in a host, and each
  would end or widen the directive. `presentationFor` checks a stored origin again.
- **IAM SPEAKS THE APPLICATION'S LANGUAGE, AND THE APPLICATION CHOOSES ONLY THE LANGUAGE AND THE NAME**
  (`src/app-presentation.ts`, `src/catalog/`). The contract's `locale` and `displayName` are reconciled into
  `app_presentation`; every page and IAM e-mail takes its words from the catalog of that locale, so a missing
  translation fails the typecheck, and escapes every value it inserts. The application of a request is a handoff
  login's `?app=`, a link's or a form's `?app=`/`app`, an invitation's app, or a password action's stored
  `password_action_tokens.app`; `presentationFor` names one only when IAM knows it (a presentation row or a
  registered return origin) and answers the installation's (`DEFAULT_LOCALE`, no name) otherwise, a stored locale
  IAM no longer speaks included. A hint picks words and a registered landing, never authority. There is no
  `principals.locale`: an app-less action (IAM's own forgot-password, an administrator's) speaks the default.
  `messageTemplateFor` (`src/messages.ts`) is the one place a message's template is chosen. A refused browser-facing request answers
  `authFailurePage` with a typed `AuthFailure`, in the request's language where an application is known before the
  refusal; a failure before any application is known, and logout, speak the default.
- **AN APPLICATION'S E-MAIL TEMPLATE IS PLAIN TEXT, OR HTML OF A CLOSED SUBSET IAM RENDERS FROM TOKENS; IAM PUTS IN THE
  LINK** (`app_mail_templates`, `src/messages.ts`). The contract's `mail` is a subject, a text and optionally an `html`
  per message and language, with placeholders from the closed set `MAIL_PLACEHOLDERS` (`@fabrika/auth-core`);
  `mailTemplateProblems` refuses another one, a text without `{{actionUrl}}`, a subject that names `{{actionUrl}}` (the
  token never goes into a header), is not one line or has no words besides placeholders, and an `html` that
  `mailHtmlTokens` refuses or that has no `<a href="{{actionUrl}}">`, at the build, in the checker and at IAM's
  reconcile, and `messageTemplateFor` checks a stored row again and falls back to the catalog for one it refuses, and
  for one that names `{{appUrl}}` while the app has no registered return origin (`landingUrl`). IAM builds the action
  URL; the text carries every value as is, the subject with control characters collapsed and cut to the sender's
  `MAX_EMAIL_SUBJECT_LENGTH`. Without `html` the HTML part is IAM's: the escaped text as paragraphs and the catalog's
  button. With it, `renderHtml` writes each token, never the source: the subset's elements, the literal text (no `<`,
  no bare `&`), every value escaped and each `href` the escaped URL it names. Never render an application's HTML by
  string substitution over its source, and never log a template's body. A message or a language without a row is the
  catalog's.
- **A PASSWORD ACTION AND AN INVITATION THAT KEEP AN APPLICATION END IN IT.** A forgot-password request carries the
  sign-in's app; the issued action stores it, its link names it, and the completed action's 302 goes to the app's
  first registered return origin (`landingUrl`), never an address the request gave. An accepted invitation does the
  same for its app. The application's proxy then signs the browser in through the normal handoff, which asks nothing
  because the IAM session is moments old (`JUST_SIGNED_IN_SECONDS`); `readHandoff` and `safeRedirect` are unchanged. An action without its own
  registered origin lands on the installation's landing, below. An invitation without one answers its outcome page.
- **A FLOW THAT NAMES NO DESTINATION LANDS ON THE INSTALLATION'S LANDING, NEVER ON IAM'S BARE ORIGIN**
  (`installationLanding`), which serves no page and which the Zerops proxy answers with 403. That is the console (the
  first admin audience with a registered origin), or IAM's sign-in page without one. It covers a login with no handoff
  and no accepted `?redirect=` (password, OIDC, local), a sign-out without one, and a password action or invitation
  enrollment without its own landing: `issueSession` lands a `redirect: null` there, and `handleLogout` a refused one.
  A same-origin `?redirect=` still wins; the landing is chosen by IAM from the registry, never by the request.
- **THE LOGIN COOKIE BELONGS TO IAM'S HOST AND NOWHERE ELSE (ADR-0023).** There is no
  `SESSION_COOKIE_DOMAIN` and `CookieOptions` has no `domain` field, so a parent-domain cookie is not
  expressible. `SESSION_COOKIE` is `__Host-px_session`, and the prefix makes the BROWSER enforce the
  same rule: it refuses any cookie of that name without `Secure`, without `Path=/`, or with a
  `Domain`. A session reaches an application through the one-time code and nothing else, so an app
  sharing a domain with IAM is not a special case any more — it pays one extra redirect on first
  sign-in and gets the same cookie every other app gets.
- **A HELD LOGIN HANDS OFF AT ONCE ONLY TO AN APP IT ALREADY CHOSE** (`auth/login.ts`, ADR-0023 §6). `GET /auth/login`
  with a valid handoff and `currentLogin` (an active user's IAM session) issues the code only when
  `sessions.hasActiveChild(login, app)` or the login is younger than `JUST_SIGNED_IN_SECONDS`. Otherwise it answers
  `chooseAccountPage` and issues NO code. `POST /auth/login/account` is `sameOrigin`, reads the handoff
  (`readHandoff`) and the login (`currentLogin`) again, then issues the code (`continue`) or ends the login through
  `endLogin`, the same revocation as `/auth/logout`, and 302s to IAM's sign-in page of the same handoff (`another`).
  Never issue a code from the GET, and never act on a posted session or label. The page's `form-action` admits the
  handoff's registered origin, below. Token renewal never reaches this: the proxy re-mints from its app session.
- **`readHandoff` has TWO outcomes once `?app=` is named**: the return address is in that app's
  registry and the browser gets a code, or it is not and this is a 400 NAMING THE ADDRESS. An empty
  registry is the second case, not an opt-out. Restoring a fallback recreates the login loop SEC-6
  found — a login that succeeds and lands the browser where it has no session, with nothing logged.
- **`safeRedirect` accepts IAM'S OWN ORIGIN AND NOTHING ELSE**, and answers null for anything else.
  Not the cookie domain (there is none), not `*.localhost` locally. The return-origin registry is the ONLY authority on sending a
  browser to another host, and `readHandoff` has consulted it before this ever runs; a second, weaker
  answer to the same question is how an open redirect gets in.
- **`Secure` is unconditional on every cookie this service writes**, including the clear-cookie on
  logout — a deletion must satisfy the same attribute rules or the browser keeps the original. It
  used to be derived from the issuer's scheme; `__Host-` removed the decision, because without
  `Secure` the browser stores nothing at all.
- **`ENVIRONMENT=local` IS REFUSED WHEN `ISSUER` IS NOT A LOOPBACK ORIGIN** (`readEnvironmentName`,
  `@fabrika/auth-core`). `local` is not a label — it is the one string `localDevLogin` and the ephemeral
  signing key are both gated on, and a live installation was
  measured carrying it (backlog 59). What proves a process is not local is the PUBLIC ORIGIN it serves
  on, because that value cannot be wrong quietly: it is the `iss` of every token it mints, the host
  its `__Host-` cookie belongs to, and the address a browser is sent back to. The COMPOSITION ROOT
  states it and shared code enforces it, the `client-address.ts` rule — and stating none is supported
  and means no claim, never a guess. Enforced in `buildServices` (both engines, the `buildOidc` shape)
  AND in `node/runtime.ts`, because a process that only fails per request still answers `/healthz` and
  would pass its readiness probe.
- **Signing keys come from `FABRIKA_IAM_SIGNING_KEYS`** (a JSON array of private JWKs). Index 0 is
  the active signer; every key is published in the JWKS so a rotation key verifies before it is
  promoted. With no keys configured an EPHEMERAL key is generated per isolate — fine for dev,
  refused on stage/prod.
- **NO KEY MEANS NO SURFACE.** An unset `rpcKey`/`proxyKey` makes the HTTP transports 404 as if they
  were never mounted. There is no path in which the check is skipped, and a misconfigured deploy
  loses RPC rather than publishing it.
- **The RPC shared secret is TRANSPORT auth, not caller identity.** It replaces what a service
  binding's unreachability gives on Workers, and does not substitute for the per-caller
  authorization the management RPCs already do. Never reuse `FABRIKA_IAM_PROVISIONING_KEY` for it —
  that key resolves to a synthetic global admin.
- **A DEPLOY NEVER OVERWRITES AN ADMIN'S POLICY.** `putAppSchema` 409s when a declared role key
  already exists as an `origin='custom'` row — symmetric with `createPolicyUseCase`, which 409s on an
  existing app role. `reconcileAppSchema`'s upsert carries `WHERE roles.origin = 'app'` as the second
  lock. Without both, a deploy flipped a custom policy to `origin='app'`, after which update and
  delete require `origin='custom'` and 404, and the policy became unmanageable.
- **A reconcile CLEARS THEN WRITES, so no statement's width depends on the catalog.** D1 allows 100
  bound parameters per query and the old `NOT IN (…)` prune spent one per kept value; an app with a
  hundred actions could not reconcile at all. The batch is one transaction, so there is no window in
  which the app has no vocabulary.
- **Permission resolution is fail-closed and pure.** `computePermissions` (`src/resolve.ts`) takes
  already-fetched rows, so it is unit-testable without a database. Unparseable inline grant JSON and
  an unresolvable role key both contribute ZERO permissions. Wildcards stay as patterns — `permits()`
  in `@fabrika/auth-core` matches them; never pre-expand.
- **Both migration sets must land the same OUTCOME.** `migrations/` (SQLite/D1) and
  `migrations-postgres/` state the same schema; `src/db.ts` runs against both with one dialect switch (how a guarded
  change writes its record, above), and
  `src/__tests__/postgres-schema.test.ts` pins it against a real database. Add a change to both,
  knowingly. Bundle `iam`, its ledger, and advisory lock `7214839201` are durable identity; before 1.0
  the history may be squashed when installations are reinstalled (ADR-0017). A migration that cannot
  state a correct outcome for existing rows REFUSES rather than guesses. Bun's `Database.exec()`
  swallows a step error and runs on, so a test that proves a refusal applies the file one statement at
  a time, the way `wrangler d1 migrations apply` does.
- **Never log a secret, a key, or an error object that may quote a connection string.** Log which
  surfaces are enabled, not what enabled them. `src/log.ts` (`logError`/`logWarn`) is the ONE place a
  caught value becomes a log line, and it emits only an `Error`'s own message — a driver error
  carries the DSN it failed on and a fetch error carries the URL. Never pass a caught value to
  `console.*` directly.
- **OIDC configuration is FATAL when incomplete, on both engines.** `buildOidc` requires
  `OIDC_ISSUER`/`OIDC_CLIENT_ID`/`OIDC_CLIENT_SECRET` whenever the method is enabled. The Bun path
  always did; the Worker substituted empty strings and served a method that could only fail at the
  redirect. Refusing to boot beats booting misconfigured — so a local `wrangler dev` is password-only.
- **IAM IS THE OAUTH 2.1 AUTHORIZATION SERVER FOR MCP CLIENTS, AND ONLY FOR REGISTERED ONES (ADR-0049).**
  `OAUTH_CONFIG` (deploy var `FABRIKA_IAM_OAUTH_CONFIG`; unset = every OAuth path 404s, malformed
  fails the boot) lists the Claude/ChatGPT CIMD client ids with their exact redirect URIs, and the
  resources with their scope ceilings. An unregistered client id is refused before any fetch, and a
  fetched metadata document can never add a redirect URI. A scope grant is a CEILING: the token's
  `perms` are the user's LIVE permissions at the resource's app narrowed by it (`narrowPermissions`),
  re-resolved at every code exchange and refresh together with the grant, its IAM session, and the
  principal. A grant expires with the session it was given under and cascades with its row. One code
  per grant, so the grant IS the refresh-token family: a replayed code or a reused rotated refresh
  token revokes it. Resource tokens are signed with `typ: at+jwt` (`Signer.signResourceToken`).
- **REVOCATION STOPS REFRESH, NOT AN ISSUED ACCESS TOKEN.** Revoking an OAuth grant or ending its
  session refuses the next code exchange or refresh; an access token already minted stays valid until
  its `exp`, at most `DEFAULT_TOKEN_TTL_SECONDS`. `verifyAccessToken` (every native caller) refuses a
  resource token; only `verifyResourceAccessToken` reads one, and only for `/oauth/revoke`.

## Patterns

- Minting is two fronts over one resolve→sign core (`src/tokens.ts`): `mintToken` from the browser's
  opaque `__Host-px_session` cookie, `mintFromKey` from a `px_` credential. Both end in `signAccessToken`,
  so this runs about once per TTL per app — not per request.
- Human authentication methods compose (ADR-0020); password support is `src/password-*.ts` and its
  transient rows are pruned by the same cron as `auth_log`.
- Every admin list is a PAGE: `before` (a keyset cursor over the UUIDv7 id) + `limit`, one query for
  the page and one for its fan-out. `principalStatus` is expressed in SQL rather than filtered after
  the read, because filtering afterwards made `limit` mean nothing. `cron.test.ts` asserts a row count
  per table, so adding or dropping a table the sweep owns is a visible test change.
- Background work goes through the `WaitUntil` port, so a Worker's `scheduled` writes settle and a
  process logs a failure instead of dying on an unhandled rejection. A change's audit row is never background work.
