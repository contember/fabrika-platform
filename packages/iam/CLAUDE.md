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
  `src/node/server.ts` (the Caddy proxy writes it after deleting the caller's, and this process is not
  publicly routed) — and shared code reads that one and nothing else. **Naming none is supported and
  means no per-client bucket at all**, never a guess. Never name a header the ingress does not
  overwrite.
- **THE AUDIT CORRELATION ID FOLLOWS THE SAME RULE** (`src/request-id.ts`). The root names the header:
  `cf-ray` in `src/index.ts` (no proxy strips a caller's `X-Request-Id` in front of the Worker),
  `X-Request-Id` in `src/node/server.ts` (the proxy deletes and re-injects it). Naming none means a
  generated id. Any value — header or `IamRpc` `requestId` (`src/rpc.ts`) — must pass
  `acceptRequestId` (≤ 64 chars, `[A-Za-z0-9._:-]`) or it is REPLACED by a generated id, never
  truncated and never refused. No unvalidated caller string reaches `auth_log` or `audit_events`.
- **The per-client bucket decides admission from the RETURNING of the statement that increments it.**
  The account and deployment-wide buckets read first and record afterwards, which a concurrent burst
  walks straight through; that is tolerable for a key an attacker cannot pick, not for the one bucket
  whose job is to bound a burst. It counts every attempt (a decision taken before the work cannot know
  the outcome) and a successful login does not clear it — `clearLoginFailures` is the account key
  only, or one valid credential would zero the bucket between bursts.
- **ONE MAILBOX RULE. `principals.email` is the NORMALIZED mailbox and nothing else; the spelling a
  human or an IdP used lives in `label`.** `PrincipalRepository` is the only place that applies
  `normalizeEmailIdentity`, so every caller may hand it any spelling, and every comparison is plain
  equality. Never ask the engine to case-fold an identity — SQLite's `LOWER()` is ASCII-only where
  Postgres's is full Unicode, so `LOWER(email) = LOWER(?)` used to make the BACKEND decide whether two
  addresses were one person. `principal_email_claims` is the second lock over the same rule and moves
  with a principal whose address changes.
- **The OIDC flight cookie is signed** (`Signer.signInternal`, audience `fabrika:iam:oidc-flight`).
  Its `state` cannot authenticate itself — whoever writes the cookie writes `state` too — and
  `Path=/auth` does not stop a sibling host under a shared domain from tossing in a second one. Every
  terminal outcome of `/auth/callback`, success or failure, clears it.
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
  Control's console gateway forwards as a bearer) or a `px_` key, and reads no session cookie. With
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
- **A WORKLOAD KEY CARRIES EXACTLY WHAT THE SCHEMA DECLARES FOR ITS WORKLOAD (ADR-0022 "Principal kinds").** A job or
  webhook principal is a `service` row (`external_id` `workload:<app>:<kind>:<name>`) with a `workload_principals`
  row naming its kind; a token minted from its key has `ptype` = that kind and `workload` = its name.
  `resolveCredential` resolves it to the actions of its `app_workloads` row (written by the schema reconcile from
  `AppSchema.workloads`, contract applications only, exact catalog actions), app-wide, and to nothing without one. A
  reconcile that drops a workload revokes its keys in the same batch.
- **A WORKLOAD PRINCIPAL RESOLVES NO GRANT ON ANY PATH, AND HOLDS NONE.** The one grant read every permission goes
  through, `getActiveGrantsForApp`, excludes workload principals in its SQL; `createGrant` and
  `createRoleGrantUnlessHeld` throw `WorkloadGrantError` for one, and `grants.create` answers 409 before anything else.
  A workload token is refused before any permission is resolved: by `resolveAdmin`'s token branch, by `resolveCaller`
  for every management and membership operation. `apiKeys.list`, `rotate` and `revoke` do not see workload principals.
- **AN APPLICATION WITHOUT A BINDING CALLS `/membership/<method>`, AND ITS KEY ONLY PINS THE APPLICATION** (ADR-0022
  rule 6, `src/membership-http.ts`, mounted by the Bun composition only). The bearer is the environment's membership
  transport key (`membership_transport_keys`, hash only, no `credentials` row, so no `px_` path finds it and it mints
  nothing); a call whose `app` is not the key's is `not_allowed` before the operation runs. It serves `createScope`,
  `assignMember`, `revokeMember`, `listMembers`, `issueLink` and `revokeLink`, never `requestDelegation`: only the
  proxy obtains a grant. The caller is still the token in the body. `membershipKeys.issue` (admin RPC) issues a key
  for an `<app>@<env>` id only, ≤30 days, and deletes every other key of it except `keep`; a reconcile that leaves the
  app no delegated endpoint, no link mount and no dimension that lists its members deletes its keys in the same
  batch (the schema holds no per-endpoint list fact, so a members-declaring dimension keeps the key).
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
- **MEMBERSHIP IS EVALUATED BY IAM, AGAINST THE CALLER'S LIVE PERMISSIONS (`src/membership.ts`).**
  Every `IamMembershipRpc` operation resolves the caller from its own credential and never grants it
  more than that credential carries: a `px_` key is resolved live and downscoped by its own grants, and
  a token's `perms` (up to five minutes old) count only where `resolvePermissionsAt` still holds them —
  so a token minted from a read-only key stays read-only. An
  anonymous credential, a share link included, is never a member caller; a service principal creates
  no scope and manages no member (`userOnly`), which closes "a form plus a job that invites the
  submitted email". Membership is ordinary role grants scoped to a value (compatible with backlog 91);
  a value is checked as itself, flat — "there" means that exact `(type, value)`, global grants included.
  Assigning needs the dimension's `members.manage` there, a role there that the target role's
  `assignableBy` names, and every action of the target role there; revoking needs the same for every
  role it removes. A built-in role key (`BUILTIN_ROLE_KEYS`, `admin`) is never a membership role: the
  schema parser refuses it, and scope creation also applies `contractGrantProblem` to the creator role.
  Repeating an assign or a revoke answers the same result — an active grant is kept, an expired one is
  renewed in the same statement (backlog 82's 409 stays for
  the admin grant API). `listMembers` needs `members.list` there and shows ids and roles (an
  application's member directory); labels only to `members.manage`, or to `members.list` too where the dimension
  declares `directory: 'labels'` (`app_scopes.members_directory`) — a user's label spells its address; emails and
  open invitations only to `members.manage`.
- **A MEMBERSHIP WRITE SPENDS A DELEGATION GRANT** (`delegation_grants`, ADR-0022 rule 6). IAM issues
  one only to a user principal, only for an endpoint the schema lists under `delegations`, bound to the
  caller, the endpoint and the request id, for `DELEGATION_GRANT_TTL_SECONDS`. It is consumed BEFORE
  its binding is compared, like a handoff code, and the endpoint's purpose and dimension are read from
  the schema again at use. One grant serves one operation, so a request makes one membership write.
  `listMembers` and the link operations take none: they spend no membership authority.
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
  acceptance, and its assigning role once more inside the UPDATE that consumes the invitation (`EXISTS`
  over the inviter's grant, `FOR SHARE` on Postgres through `createPostgresIamRepositories`; a D1 batch runs
  alone): a removal either commits first and the acceptance is `not_allowed` with the invitation still
  open, or waits until the acceptance committed. The guarded UPDATE stamps a fresh `acceptance_id`, and the grant is written in the same
  batch only for the attempt holding it — never on a timestamp a replay can share. Without an email service, an invitation is `invitations_disabled`; assigning an existing
  principal by id still works. Invitations live `INVITATION_TTL_SECONDS` (7 days).
- **A SHARE LINK IS BOUND TO ITS MOUNT AND ITS CHAIN** (`credentials.link_mount`, `link_dimension`,
  `link_chain`). `issueLink` checks the chain against the schema's containment, requires an expiry of
  at most the mount's `maxDays`, and requires the issuer to hold `issuedBy` and every granted action on
  some link of the chain; the grants are frozen on the object. Its token carries `link: { mount, chain }`
  and no `ptype`, and the framework re-checks the chain per request. `createLinkCredential` locks the
  mount row and inserts only while the mount still exists, so a reconcile removing it either makes the
  write insert nothing or revokes the committed key. The issuer or a holder of
  `members.manage` on a value of the chain revokes it; a reconcile that removes the mount, or moves it
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
- **EVERY IAM-OWNED CHANGE WRITES ITS `audit_events` ROW IN THE CHANGE'S OWN BATCH** (`auditEventStatement`,
  `repositories/audit.ts`). A use case builds the record (`adminEvent`, `memberEvent`) and hands it to the repository
  that makes the change, or composes several repositories' statement builders into one `audit.commit([...])`. A failed
  insert rolls the change back; never write a change's record afterwards or in `waitUntil`. A guarded change records
  itself only where its guard holds: the record is an `INSERT … SELECT … WHERE <condition>`, and a condition read
  BEFORE the change sits behind a row-locking no-op UPDATE first in the batch, or two concurrent Postgres
  transactions both read it true (`durable-audit.test.ts` fails without the lock). A no-op — a held role, a revoked
  session, a disabled principal — writes no row. A role revocation writes one row per role it removed.
  `writeAuditEvent` alone is only for rows that record no change of IAM's: an application's `audit` event, an admin's
  access, a failed email delivery. `IamRpc.audit` stays best-effort (backlog 71).
- **A LOGIN, A REFUSED LOGIN AND A LOGOUT WRITE `auth_log` BEFORE THE ANSWER.** `createSession` takes the login's row and
  `revokeSessionByHash` writes the `logout` row from the session it ends, each in the session's batch; a refused
  password or OIDC login goes through `refuseLogin`. A row that cannot be written answers 503 and opens or ends no
  session. A login of a principal holding `iam.admin` at IAM is `privileged = 1`. Mint rows (`mintToken`,
  `mintFromKey`, the handoff exchange, the workload token) are not logins and stay in `waitUntil`.
- **EVERY `/admin/*` REQUEST OF AN INSTALLATION ADMIN WRITES ONE `iam.admin.access` ROW BEFORE IT RUNS** (`admin/access.ts`),
  reads included: method, route template, and for `/admin/rpc` the procedure (a well-formed name, else null), under
  the app the admin's credential was verified for (the console gateway, or `propustka` for a `px_` key). A request whose
  access cannot be recorded answers 503 and does not run. A REST path that matches no operation, and an RPC caller
  without `iam.admin`, used no privileged access and are not recorded. A mutation therefore writes two rows: the
  access and the change.
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
  browser never leaves the form. `loginHandoffFields` widens the directive by exactly one origin, and
  that origin comes from the REGISTERED return URL, so widening the CSP can never widen where a
  browser may be sent. A page rendered for no handoff stays at `'self'`.
- **THE LOGIN COOKIE BELONGS TO IAM'S HOST AND NOWHERE ELSE (ADR-0023).** There is no
  `SESSION_COOKIE_DOMAIN` and `CookieOptions` has no `domain` field, so a parent-domain cookie is not
  expressible. `SESSION_COOKIE` is `__Host-px_session`, and the prefix makes the BROWSER enforce the
  same rule: it refuses any cookie of that name without `Secure`, without `Path=/`, or with a
  `Domain`. A session reaches an application through the one-time code and nothing else, so an app
  sharing a domain with IAM is not a special case any more — it pays one extra redirect on first
  sign-in and gets the same cookie every other app gets.
- **`readHandoff` has TWO outcomes once `?app=` is named**: the return address is in that app's
  registry and the browser gets a code, or it is not and this is a 400 NAMING THE ADDRESS. An empty
  registry is the second case, not an opt-out. Restoring a fallback recreates the login loop SEC-6
  found — a login that succeeds and lands the browser where it has no session, with nothing logged.
- **`safeRedirect` accepts IAM'S OWN ORIGIN AND NOTHING ELSE.** Not the cookie domain (there is
  none), not `*.localhost` locally. The return-origin registry is the ONLY authority on sending a
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
  `migrations-postgres/` state the same schema; `src/db.ts` runs unmodified against both, and
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
