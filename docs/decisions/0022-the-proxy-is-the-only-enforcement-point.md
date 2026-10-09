---
id: 0022
title: The proxy is the only enforcement point
status: accepted
date: 2026-10-08
---

# 0022 — The proxy is the only enforcement point

## Context

An application that enforces its own authentication is only as safe as its wiring. A route registered
before the middleware, a second entrypoint or a forgotten mount is an unauthenticated path. If the app
is also publicly routable, "the app forgot to check" and "the world can reach it" are the same
deployment. Cloudflare Access solves this on Cloudflare only; fabrika also runs on Zerops.

The enforcement point has two different jobs. **HTTP correctness** (WebSockets, streaming bodies,
HTTP/2, hop-by-hop headers, timeouts) is subtle and app-visible when wrong. **Authorization** (gate
evaluation, token minting and verification) is the security-critical path and exists in TypeScript.
Cloudflare does the first job for a Worker. Zerops needs a real reverse proxy, and Caddy's
`forward_auth` calls an external service and either forwards the request with copied headers or
returns the service's own response (a redirect to login works unchanged).

Gate rules do not map onto Caddy's route matchers. Checked against Caddy v2.10.2:

- **Fall-through is inexpressible.** A matching rule whose credential is absent falls through. Presence
  can depend on a declared header, query or cookie location, and validity on an IAM call. A matcher
  decides before either is known.
- **Caddy's path matcher is case-insensitive**; the gate glob is not. `/PUBLIC/health` would match a
  `/public/*` route in Caddy.
- **Caddy's `*` does not cross `/`**, and Caddy merges `//` before matching; the gate glob matches the
  raw pathname with `*` as `.*`.

The last two fail silently: a second evaluator gates a slightly different set of requests than the
app declared, in the permissive direction.

Browsers also constrain how a session reaches an app. `*.zerops.app` is on the Public Suffix List, so
a cookie scoped to a parent domain is refused there, and a platform that hosts apps on their own
domains cannot require them to share one with IAM.

An application now declares its whole access surface in one contract
([ADR-0012](0012-fabrika-app-runtime.md)). Gates generated from that contract leave three gaps at the
proxy:

- **A gate can only add access.** An absent credential falls through to every later matching rule, so
  a narrower rule for one endpoint does not narrow it.
- **The proxy does not know the requirement.** It tells a session from a `px_` key, but it does not
  know which kind of key a caller holds, which action an endpoint requires, or whether a request is a
  cross-site write. Only the application checks these, inside the process an agent can edit.
- **Nothing authenticates the hop to the application.** A service in the same Zerops namespace can dial
  the application directly, and the application cannot tell whether the proxy applied the rules it
  expects.

## Decision

**We will make the proxy the single enforcement point for every request to every application.** Six
rules.

The proxy evaluates one of two forms of policy. **Gates** are an ordered rule list. They protect the
installation's own services (IAM, Control, Operations), including the `oauth` gates of
[ADR-0049](0049-author-applications-through-mcp-in-control.md). An **endpoint table** is compiled from
an application's contract. It protects every contract application. Control's metadata selects the form
per service. Both forms are evaluated only by the proxy, with the matchers in `@fabrika/auth-core`.

The proxy evaluates gates for every app whose manifest entry carries gates, and the endpoint table for
every app whose entry carries one; an entry carrying both is refused. Part A generates an application's
gates from its contract as an intermediate path. Work unit B2 built the endpoint tables, B3 the
authenticated hop and B4 the response headers.

Work unit B10 moves the installation's own services from gates to endpoint tables too, as
**installation entries** (rule 3): an endpoint table that trusted platform composition marks
`installation: true` and that may use five forms no application may declare. B10a added the forms and
their hop treatment; until the later B10 units switch each service, no producer emits one, and the
services keep their gates.

### 1. Only the proxy is publicly routed

An application service has no public address. On Zerops that is the platform default. On Cloudflare
the app Worker declares no route and sets `workers_dev: false`; the provider refuses the graph
otherwise. It is reachable only through the `APP` service binding of its proxy Worker.

A Zerops namespace is one private network, so a sibling service can still reach an application. On
Zerops the proxy therefore authenticates itself to the application with a **secret per application and
environment** (rule 5). On Cloudflare the service binding is the authenticated hop: the application
Worker has no public route, and nothing else can bind it
([ADR-0048](0048-bind-cloudflare-delivery-to-the-recorded-commit.md)). Cloudflare has no proxy secret.
This holds only against code without the account credential: until backlog 86 lands, repository code
holds `CLOUDFLARE_API_TOKEN` and can bind or expose the application Worker directly
([ADR-0048](0048-bind-cloudflare-delivery-to-the-recorded-commit.md#on-cloudflare-these-are-a-strong-default-not-a-security-boundary)).

IAM stays **global**: one identity database, one audit log, one console. The proxy is **stateless**
and per deployment boundary: one per namespace on Zerops, one per app environment on Cloudflare. An
ordinary request calls IAM only on the cold path; the warm path verifies a cached token locally. A
membership-management request is the exception: it obtains a fresh single-use delegation grant from IAM
even when the token cache is warm (rule 6).

**Invariant: the proxy holds no state that a decision depends on.** Its token cache is best-effort,
in memory and per process. Without it IAM is called more often; no decision changes. Never make it
shared or persistent.

### 2. Caddy owns HTTP correctness and gets no vote on authorization

On Zerops the proxy is Caddy plus a loopback Bun auth service. On Cloudflare a thin Worker runs the
same `@fabrika/proxy-core` code in-process. Caddy's admin API is disabled; the gate configuration is
baked into the deploy artifact.

The Caddy configuration is a **fixed chain per app**, identical whatever the gates or the endpoint
table say:

1. **Delete** the headers a client must not assert — every `X-Fabrika-*` header, the request id, the
   client address and the forwarding headers — and set the client address from Caddy's own
   `client_ip`. One list of every `X-Fabrika-*` name in `@fabrika/auth-core` feeds this step and the
   Cloudflare proxy Worker.
2. `forward_auth` to `/verify?app=<id>`. The app id is pinned in the route, never derived from a
   client-influenced header.
3. `reverse_proxy` to the private upstream, with every `__Host-px_*` cookie stripped and, for an
   application, the proxy secret set. Caddy reads the secret from a managed variable through an
   `{env.…}` placeholder.

Step 1 must be a delete, not an overwrite: `copy_headers` skips an empty auth-response value, so a
client's own `X-Fabrika-Token` would otherwise reach the app on a `public` path.

**Response headers.** The proxy sets one conservative header policy on every response of a contract
application and on its own denials: Caddy through its response operations, the Cloudflare proxy Worker
in code, and `@fabrika/proxy-core` on every answer it writes. The proxy **replaces** whatever the
application set for these names, so an application can neither omit nor weaken the policy. The
framework sets the same policy in-process; both read the one definition in
`@fabrika/proxy-core/headers`. An answer that belongs to no contract application (the denial of a gate
app or of an installation entry, a forward refused before an app is selected) carries the policy
without named origins; an installation service's own answers pass through unchanged, because IAM and
Control set their own per-response CSPs for login, consent and their console flows. Per-endpoint
profiles and caching of static assets are not part of v1.

The proxy also **deletes** four headers an application may not send at all, on every answer and every
download: `Content-Security-Policy-Report-Only`, `Report-To`, `Reporting-Endpoints` and `NEL`. Each names
a reporting endpoint the policy never approved, and a report-only CSP reports the document and blocked
URLs there whatever the enforced CSP says. A `1xx` answer of the application (`103 Early Hints`) leaves
the proxy with no header at all: Caddy forwards it before its response operations run, so a deferred
handler around the upstream clears it, and an application cannot preload a script or send a policy
through it. The Cloudflare runtime does not hand a Worker a `1xx` answer. When the application binding
fails, the Worker answers a fixed `502` with the same treatment, never the error.

The policy:

- `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
  img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' <operations ingest>;
  form-action 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`. `<operations ingest>`
  is the installation's Operations ingest origin; the framework takes it from `FABRIKA_OPERATIONS_DSN`,
  and the proxy from its manifest entry's `operationsOrigin`, the origin of the same DSN: the Cloudflare
  provider reads it from the run's managed environment, and on Zerops Control hands it to each namespace
  member (`ProviderNamespaceMember.operationsOrigin`). The DSN's key never reaches a manifest. The
  contract may extend `connect-src`, `img-src` and `frame-ancestors` with named origins — exact
  `https://` origins with a literal host, never a pattern, at most 16 per directive
  (`MAX_CSP_ORIGINS`, checked by the contract build and the manifest parser); such an extension is
  approvable
  ([ADR-0050](0050-approved-access.md)).
- `X-Content-Type-Options: nosniff`.
- `Cache-Control: no-store`, static assets included.
- `Referrer-Policy: no-referrer`.
- `Cross-Origin-Opener-Policy: same-origin`.
- `Permissions-Policy` with every powerful feature off: `accelerometer`, `ambient-light-sensor`,
  `autoplay`, `bluetooth`, `browsing-topics`, `camera`, `clipboard-read`, `display-capture`,
  `encrypted-media`, `fullscreen`, `gamepad`, `geolocation`, `gyroscope`, `hid`,
  `identity-credentials-get`, `idle-detection`, `local-fonts`, `magnetometer`, `microphone`, `midi`,
  `otp-credentials`, `payment`, `picture-in-picture`, `publickey-credentials-create`,
  `publickey-credentials-get`, `screen-wake-lock`, `serial`, `storage-access`, `usb`, `web-share`,
  `window-management` and `xr-spatial-tracking`, each `=()`. `clipboard-write` stays on: copying is
  an ordinary application feature and reads nothing.

A download endpoint gets the **file treatment** instead. The proxy recognises it by the endpoint the
decision selected, never by a path of its own:

- `Content-Disposition: attachment` for every type except the inert images `image/png`, `image/jpeg`,
  `image/gif` and `image/webp`, which are served `inline`. SVG and HTML are always attachments. The
  proxy sets the disposition type from the answer's exact `Content-Type` and keeps its parameters
  (the file name). `inline` needs exactly one `Content-Type` value from that list: repeated fields are
  joined into one value first, which no listed type equals, so any duplicate is an attachment.
- `Content-Type` from the recorded, sniffed type, never from the upload request.
- `X-Content-Type-Options: nosniff`.
- `Content-Security-Policy: sandbox; default-src 'none'`.
- `Cache-Control: private, no-store`, so a revoked user cannot read a cached copy.

**Invariant: a header a client can set never reaches a decision.**

**Invariant: fabrika browser credentials terminate at the proxy.** The app receives the verified token
header and its own cookies, never a fabrika session or handoff cookie. The one exception is the
platform proxy's route to IAM, which keeps IAM's own login cookie.

### 3. Gates and endpoint tables are evaluated once, in TypeScript, by the proxy

A gate rule or an endpoint row never compiles into a route matcher, a firewall rule or any other
engine's configuration. The proxy receives the gate list or the endpoint table verbatim in its
manifest and evaluates it with the canonical matchers in `@fabrika/auth-core`.

**Gates (installation services).** Array order is precedence. A matching rule with an **absent**
credential falls through; with a **present** credential it is terminal. A request that matches no rule
is denied.

- `public` — terminal allow, no credential read, no IAM call, no token.
- `service` — a `px_` credential, as a bearer or at the declared location. A share link is one. Any
  other credential there is a 401 with no IAM call.
- `human` — a resolved **user** principal. A valid token is not enough; every tier checks the claim.
- `oauth` — an OAuth access token for the declared resource and scopes
  ([ADR-0049](0049-author-applications-through-mcp-in-control.md)).

**Endpoint tables (contract applications).** The manifest carries `{ id, hosts, upstream, scheme,
endpoints, reservedPrefixes, snapshot, csp, operationsOrigin? }` per application; `snapshot` is the
contract digest and `csp` the contract's named origins. Each
endpoint row is `{ id, kind, method, path, callers, requirement, admission, delegation, digest }`, and
the manifest parser refuses a row whose digest does not describe its rules. Array order has no meaning
here. The proxy makes one pass over one selected endpoint:

1. **Canonical path.** The raw path must have no empty segment, no `.` or `..`, no encoded `/` or `\`
   and no literal `\`. Otherwise the answer is 400. A request without a method is denied. A trailing
   `/` is significant and matched literally: `/a/` and `/a` are different paths.
2. **Selection.** `planEndpoint` selects the most specific endpoint: a literal segment beats a
   parameter, and a parameter beats a wildcard. An RPC prefix is reserved for its procedures. No
   endpoint is a 403. There is no fall-through to another endpoint.
3. **A `px_` key is present.** The proxy mints from it with `mintFromKey`. The key's principal kind must
   be one of the endpoint's callers. This step is terminal: a rejected key never falls back to a
   session.
4. **No key.** When `human` is a caller, the proxy uses the session, or answers with the login
   redirect of rule 4. When `human` is not a caller, the answer is 401, never a login redirect.
5. **Requirement.** The token must satisfy the endpoint's requirement: `member` (any permission of this
   application), or the action in some scope. Otherwise the answer is 403.
6. **Admission.** A session-authenticated request that is not `GET` must carry
   `Sec-Fetch-Site: same-origin`. An RPC request must carry `Content-Type: application/json`. An upload
   admits only its declared content types.

**Anonymous kinds.** An endpoint of an anonymous kind (`c.health`, `c.form`, `c.webhook`, and the shell
of a link SPA) has no callers. The proxy skips steps 3 to 5, mints no token and forwards the request.
It does not forward a `px_` key or a session that arrives on such a request; only an installation
entry's `protocol` row keeps the `Authorization` header (below). Admission still applies:
a form admits only its content type. Its body limit is the framework's, because `forward_auth` hands
the proxy the headers and never the body. A webhook's signature is verified by the framework, not by
the proxy.

**Principal kinds.** A `px_` key has its own principal kind. The kinds are `user` and `service`, plus
`link`, `app`, `job` and `webhook`, each added with the feature that needs it. The caller `human`
admits a session or a `user` key; `machine` a `service` key; `link` a `link` key; `app:<id>` the
connector key of application `<id>`, and only on export paths. Job and webhook keys are accepted by no
mount. The proxy refuses an unknown kind, on cached paths too. An OAuth resource token is no `px_` key:
`callerOf` maps it to the caller `oauth`, which only an installation entry's row may admit, so every
application endpoint refuses it.

A workload token carries its kind in `ptype` and names its workload in `workload`: the job's or the
webhook's name, or for `app` the consuming application's id. `callerOf` maps `app` to `app:<workload>`
and `job` and `webhook` to no caller; `callerAdmittedAt` admits `app:<id>` only under
`/__fabrika/connect/`. A `service` gate refuses a workload token too, and neither `@fabrika/auth` nor
IAM's management and membership operations accept one. IAM stores a workload principal as a `service`
row whose `workload_principals` row names its kind. A workload key resolves to exactly the actions the
reconciled schema declares for the workload (`AppSchema.workloads`, app-wide), never to a grant, and a
reconcile that no longer declares the workload revokes its keys. Control issues one key per job and per
webhook declaration of the approved contract (`workloads.issueKey` on IAM's admin RPC, with the
provisioning key), seals it in its vault and writes it as `FABRIKA_<KIND>_<NAME>_KEY`; it rotates a key
once less than half of its 30 days is left. Each issuance names the key Control recorded as active, and IAM revokes
every other key of the workload but the new one, so the running version keeps its key until Control records the
replacement. A workload principal resolves no grant and can be given none.
The application exchanges its own job or webhook key at `POST /auth/workload/token` on IAM's public
origin, which signs only for a workload key of the named application: it checks the key's format and the per-client
bucket before any lookup, answers every other key the same `invalid_key`, and answers a storage failure 503. Work unit B9a built this for jobs
and webhooks. Connector keys of kind `app`, their edges and compatibility checks are B9b; until then an
export also admits `machine` for an operator-provisioned edge key.

**Installation entries.** An endpoint table that protects one of the installation's own services is a
manifest entry `{ id, hosts, upstream, scheme, installation: true, endpoints, reservedPrefixes,
oauthResources? }`. The marker comes from trusted platform composition — the installation's platform
proxy manifest and its Cloudflare proxy Workers — never from the shape of an id; that the id holds no
`@` is only a consistency check. Such an entry has no contract, so it carries no `snapshot`, no `csp` and
no `operationsOrigin`. Its rows are `{ id, kind, method, path, callers, requirement, admission,
delegation, oauth, digest }`, with `delegation` always `null`. They may use five forms that no
application may declare:

- **Kind `protocol`**: anonymous like `health`, for an endpoint the service authenticates itself (IAM's
  login, handoff, OAuth, JWKS, `/admin/*` and `/rpc/*`; Operations' ingest and upload; a signed webhook).
  The proxy reads no credential and mints no token, but it forwards the request **with**
  `Authorization`, which the service reads.
- **Kind `service`**: credentialed, served by a raw handler of the service (its console, a typed RPC
  mount, a gateway). The kinds of an installation row are `service`, `protocol` and `health`.
- **Method `*`**: any method. For the ambiguity check it overlaps every method of the same path shape,
  so `*` and `GET` on one shape are refused like two `GET`s.
- **Caller `oauth`**, with `oauth: { scopes }` on the row; every other row carries `oauth: null`. A
  bearer that is not a `px_` key, on a row that admits `oauth`, is verified locally as an RFC 9068
  resource token for the entry's registered OAuth resource whose path is the row's path, and must carry
  every scope of the row. A refusal carries the RFC 6750 `WWW-Authenticate` challenge with the resource
  metadata URL, and so does a request without a bearer when `human` is not a caller. It is never a login
  bounce. A `px_` key keeps its precedence: an invalid one is a 401 and one whose caller kind the row does not
  list is a 403, each with the same challenge. The callers of an installation
  row are `human`, `machine` and `oauth`.
- **Requirement `authenticated`**: the caller kind must be listed, and no permission is needed. It is
  the only requirement of an installation row: an administrator of IAM alone holds no permission of the
  console, and a typed RPC mount authorizes each procedure itself.

Otherwise an installation row is decided by the same steps 1 to 6. The digest covers the row's OAuth
scopes as well; the resource URI is bound by the producer and checked by the manifest parser, not by the
digest. An application row's digest is unchanged by the field, byte for byte. The caller `human` admits a
`user` key without a session here too: a console row that serves only the static shell therefore admits a
`user` key, which we accept as a bounded exception because the shell carries no privilege.

Three layers refuse the five forms for an application: the contract build and the artifact schema of
`@fabrika/app/contract`, the static reader (which reads only `defineContract`), and the manifest parser.
The parser reads an entry without `installation: true` as an application, whose rows admit none of the
forms. It refuses an installation entry whose id holds `@`, that carries `snapshot`, `csp` or
`operationsOrigin`, or whose `oauth` row has no registered resource on its path or asks for a scope the
resource does not support.

An installation entry gets the hop of a gate entry: the proxy keeps `Authorization` on the upstream
hop, sets no proxy secret and sets no response policy; its own denials carry the base policy. It also
copies `X-Fabrika-Endpoint` to the service, and the proxy answers the entry's RFC 9728 metadata paths and
the handoff callback before selecting an endpoint, as it does for a gate entry.

The requirement check and the admission check are part of the proxy's decision whether a request
reaches the application. The requirement reads only the token; it needs no application-owned object.
The application repeats the caller and requirement checks as **authorization** (rule 5).

**Invariant: every unexpected condition denies.**

**Invariant: a decided negative and an unreachable IAM are different denials.** A bad credential is a
401/403. "We could not check" is a 503, and a 503 never degrades into a bounce to login.

### 4. A session reaches an app through a one-time code the proxy redeems

On a `human` gate miss, or on an endpoint whose callers include `human` when the request has no
session, the proxy answers with the login URL: a **302** for a document navigation, a **401** with
`{ error: { type, message, loginUrl } }` otherwise. The signal is `Sec-Fetch-Mode`, which the browser
writes and page script cannot. An absent value reads as a navigation.

IAM authenticates the human, issues a single-use code bound to `(session, app, return URL)`, and
redirects to `/__fabrika/auth/callback` on the app's own host. The proxy answers that path before gate
or endpoint matching, redeems the code with IAM, sets the returned **child app session** as a host-only
cookie and redirects to the stored return URL. [ADR-0023](0023-one-session-per-host.md) makes this the
only session-delivery mechanism and binds each code to the browser that started the login.

Redemption yields a session, not an access token. An access token lives five minutes. A browser that
held only that would be redirected on every expiry, and a redirect turns an in-flight `POST` into a
bodyless `GET`. The proxy re-mints from the session server-side instead.

**Invariant: a child session mints only for the app it is bound to.** A child cannot create another
child; only an IAM login authorizes a handoff.

**Invariant: the code is single-use, lives two minutes and is stored only as a hash.** Consumption is a
conditional `UPDATE`, so a replay changes no rows. The proxy's log redaction covers `?code=`; Cloudflare
proxy Workers disable automatic invocation logs, which sit outside that redaction.

**Invariant: revoking an IAM login revokes every app session derived from it.** A child carries its
parent's id and every use joins to the parent. An already-minted access token stays valid for the rest
of its TTL.

**Invariant: the proxy writes a long-lived cookie on exactly one path** — a successful redemption at
the callback. The only other cookie it writes is the transient handoff verifier of ADR-0023.

### 5. An app verifies what the proxy sent; it never enforces

The proxy injects a verified access token as `X-Fabrika-Token`. `@fabrika/auth` verifies it locally
against IAM's JWKS (signature, `iss`, `aud`, `exp`) with the shared verifier of
[ADR-0040](0040-share-one-token-verifier.md) and builds the `AuthContext`. It evaluates no gate,
exchanges no session, writes no cookie and issues no login bounce. Verifying the audience keeps a token
minted for another app out.

For a contract application, the hop carries more facts, and the application checks them:

- **The proxy secret, on Zerops.** The application checks it before anything else and refuses a
  request without it. A direct dial inside a Zerops namespace therefore gets no answer from application
  code. Control generates the secret per application and environment and writes it as a managed
  variable to the proxy and to the application. On Cloudflare the service binding takes its place
  (rule 1).
- **The endpoint.** The allow response carries `X-Fabrika-Endpoint: <id>@<digest>`. The digest covers
  the endpoint's kind, method, path, callers, requirement, admission and delegation. The application serves the
  endpoint the id names, and only when its own `planEndpoint` selects the same endpoint and the digest
  equals its own; a missing header or any disagreement is a 503. A request is therefore never served by
  code that expects different rules than the proxy applied. A health endpoint alone may arrive without
  the header, because the platform's liveness probe dials the application directly.

An installation service checks the endpoint as well, with one stated exception: it requires the header
on its credentialed rows only. A `protocol` or `health` row may arrive without it, because the service
authenticates such a request itself, and such requests also arrive unfronted — at IAM's own Worker on
Cloudflare, and over the private hops between the services. An installation service gets no proxy
secret, as it gets none under gates.

Work unit B3 built the hop. `FABRIKA_HOP_HEADERS` in `@fabrika/auth-core` is the one list of every
`X-Fabrika-*` name a hop carries; Caddy and the Cloudflare proxy Worker delete exactly it. The secret
travels as `X-Fabrika-Proxy-Secret`. Control seals it in its vault the first time an environment
joins a namespace proxy and never rotates it on its own. The proxy service holds one variable per
application, `proxySecretVariable('<app>@<env>')`, because one proxy fronts a whole namespace; the
application holds `FABRIKA_PROXY_SECRET` and compares digests in constant time. The Bun adapter refuses to
start without it. No authored variable may reference a framework-only variable, so the secret cannot be
copied into one the application controls, and Control redacts it from run logs. A health
endpoint is served without the secret, for the same reason it may arrive without the endpoint
header. The Operations upload headers are not hop headers: a client sends them to Operations
through the platform proxy.

At startup the application compares its contract digest with `FABRIKA_CONTRACT_DIGEST`, a literal in
the execution descriptor ([ADR-0043](0043-validate-and-render-one-zerops-descriptor-meaning.md)). It
refuses to start on a mismatch.

The publish order stays proxy, application, IAM. Because of the digest check the order is safe in both
directions. During a switch, changed endpoints answer 503 and new endpoints answer 404.

An app owns the check a path gate or an endpoint row cannot make: `can(action, scope)` over an
application-owned object, resolved from validated request data. The framework of ADR-0012 also repeats
the caller-kind and requirement checks. These checks are authorization. They never replace the proxy's
decision, and the proxy's decision never replaces them.

**Invariant: an application issues no credentials.** `@fabrika/auth` issues and redeems nothing.
IAM issues every `px_` credential: share links on an application's request, checked against its
caller's live permissions ([ADR-0012](0012-fabrika-app-runtime.md)), share links and API keys from
its admin surface, machine keys through `fabrika control key issue`, a job's and a webhook's key and an application
environment's membership transport key through Control's reconcile, builder credentials through device authorization
([ADR-0042](0042-connect-local-builders-through-human-consent.md)). IAM signs an access token only from a session (`mintToken`)
or a `px_` credential (`mintFromKey`); there is no free-standing signed token to present.

**Invariant: an application has no local authentication variant.** `createIam` requires the binding
and the issuer everywhere. The one dev bypass belongs to IAM: a login that requires `ENVIRONMENT=local`
and `LOCAL_DEV_LOGIN=true`. No environment admits a credential-less caller.

**Invariant: IAM's `/admin/*` is bearer-only.** It accepts the proxy token Control's console gateway
forwards as a bearer (its audience must be a registered admin gateway) or a `px_` key, and reads no
session cookie. Admission for the console is Control's gateway origin guard; IAM keeps no origin
registry of its own.

### 6. An application token is minted for one application in one environment

- **The IAM application id carries the environment:** `<app>@<env>`, for example `notes@prod`. `@` is
  reserved in application ids. One helper in `@fabrika/auth-core` builds and parses the id. The proxy
  mints for that id, and Control registers schemas, return origins and keys under it. A staging key is
  therefore refused at production.
- **An application token carries only grants of that application id.** Cross-application grants and
  the bootstrap `admin` grant reach only a registry of platform audiences, separate from
  `adminAudiences`.
- **An application token cannot call `issueKey`, `revokeKey` or `listPrincipals`**, on any transport.
- **Delegation grants.** For an endpoint whose action is a dimension's `members.manage`, or that
  creates a value of a dimension, the proxy obtains a single-use grant bound to the endpoint and the
  request. IAM requires it for scope creation, assignment and revocation, so a handler on another
  endpoint cannot spend the caller's authority. The proxy obtains a fresh grant for every such
  request, also when the token cache is warm. IAM issues a grant only for an endpoint the
  application's schema lists under `delegations`, to a user principal, and consumes it like a handoff
  code: once, before its binding to the caller, the endpoint and the request id is compared.
- **Exact actions on every write path.** For a contract application, IAM refuses a wildcard action on
  every write path. In every application, contract or not, IAM refuses a global grant of a role
  declared with `member.scope`, and such a grant resolves to no permission.
- **A bound on token size**, so that a person in many workspaces cannot exceed the proxy's header
  limit. IAM signs no access token above 8 KiB and answers `token_too_large`, which the proxy turns
  into a 403, never a login bounce. Bun, the application runtime on Zerops, refuses more than
  16 KiB of request headers; Caddy and Cloudflare allow more.
- **Revocation takes effect within the token lifetime of 300 s.** This holds for sessions and for keys,
  share links included. Membership operations are checked live at IAM.

Work units B5 and A12 built rule 6 at IAM, and B2 built the proxy side of delegation grants: a row
marked `members` or `creates` gets a fresh grant from IAM's `requestDelegation` for every request,
forwarded in `X-Fabrika-Delegation`. On Cloudflare the proxy calls it on the `IAM` binding; on Zerops on
IAM's proxy surface, `/auth/mint/delegation`, because the grant's authority is the caller's token in the
request and the proxy key adds none. The platform audiences are IAM
(`propustka`), the console (`vozka`), Operations and every admin audience. A contract application is
one whose IAM schema carries `contract: true`; `schemaFromContract` sets it. `listPrincipals` is
refused for an application token; an application lists the members of a value with IAM's
`listMembers`, which checks the dimension's `members.list` action there. A share-link key has the
principal kind `link`: its token carries no `ptype` and names its link mount and containment chain.

On Zerops an application has no IAM binding. It reaches IAM's membership operations at `POST /membership/<method>` on
IAM's public origin, with a **membership transport key** of its application environment as the bearer. Control
issues that key from the approved snapshot while the contract has an endpoint with a delegation or a share-link mount,
rotates it like a workload key, and writes it with IAM's origin as `FABRIKA_IAM_RPC_KEY` and `FABRIKA_IAM_RPC_URL`;
a reconcile that leaves the application neither deletes it. The key pins the application id: a call for another
application or environment is refused. It adds no authority, because every operation still acts as the caller's token,
and scope creation and membership changes spend the proxy's grant; issuing and revoking a share link needs none, as
on Cloudflare. It is no principal kind and no `px_` credential IAM resolves, so it mints
nothing. The surface serves no `requestDelegation`: only the proxy obtains a grant. Work unit F3 built this.

## Consequences

- **Unreachability is structural**, and one implementation of the security-critical path serves both
  providers. A fix lands once.
- **A narrower endpoint really narrows.** An absent credential no longer falls through to a later rule
  for a contract application. Fall-through stays for installation gates only.
- **Installation-only forms widen what an installation entry can say, never what an application can.**
  The marker comes from platform composition, and three layers refuse the forms in an application.
- **The proxy checks what an agent can loosen inside the application:** the caller kind, the
  requirement and admission. A loosened handler or a skipped framework check no longer opens an
  endpoint the contract does not open.
- **The application and the proxy agree per request.** The endpoint id and digest bind each request to
  the rules the proxy applied. A version switch costs 503 and 404 answers for the changed and new
  endpoints, never a request served under the wrong rules.
- **The proxy sets the response headers.** An application that omits them, or a denial the
  application never sees, still carries the policy.
- **Authenticated is not authorized at the edge.** A token carries no grant of another application or
  another environment, so a global `admin` grant no longer reaches every application.
- **IAM administration lists one entry per environment** of each application.
- **A proxy table change is a proxy rebuild on Zerops**: about 190 s of build plus 60 s of deploy,
  because the manifest is read once at build. On Cloudflare it is a Worker variable.
- **The proxy is a per-deployment single point of failure** and the only thing that establishes an app
  session. Keep it thin. If the auth service dies, Caddy answers 502 and every request is denied.
- **Zerops carries a second toolchain** (generated Caddy JSON, a pinned binary, an Alpine runtime) and
  one loopback `forward_auth` hop per request.
- **`/__fabrika/auth/callback` is reserved on every app host.** An app route there never runs.
- **The proxy's public scheme comes from the manifest** (absent means `https`); behind a TLS-terminating
  balancer no header can supply it.
- **The proxy refuses to boot without `FABRIKA_IAM_ISSUER` and `FABRIKA_IAM_KEY`**, rather than boot
  and answer 503 to everything.
- **The least-privilege split around redemption is real only on Zerops**, where `/rpc/*` takes
  `FABRIKA_IAM_RPC_KEY`, `/auth/mint/*` takes `FABRIKA_IAM_PROXY_KEY`, an unset key makes its surface
  404, and an application's own membership transport key reaches only `/membership/*`. On Cloudflare an application's proxy and application Workers bind one IAM `WorkerEntrypoint`,
  `PropustkaApplication`, which serves both the proxy's mint and redemption calls and the SDK's, so any
  application Worker can call `exchangeAuthCode`. We accept this: exploiting it needs a first-party Worker
  with the binding, a live code and that browser's handoff verifier. Key issuing and device approval are
  not on that entrypoint; only platform components bind IAM's default one.

## Alternatives considered

- **In-process SDK enforcement.** Opt-in per route, and the app is public either way; missed routes can
  only be found one at a time.
- **Cloudflare Access.** Does not exist on Zerops.
- **Per-project IAM, or a sidecar per app.** The first splits the identity database and audit log, which
  is the product. The second multiplies deployables, caches and gate copies for the same guarantee.
- **Let the proxy ask the app for its gates.** Makes the protected component authoritative over its own
  protection. The same reason keeps the endpoint table out of anything the running application reports:
  Control reads it from the commit ([ADR-0050](0050-approved-access.md)).
- **A Go plugin in Caddy.** A second implementation of the authorization check, bound to diverge from
  the Cloudflare one.
- **Traefik, nginx `auth_request`, or a TypeScript proxy on both platforms.** Traefik plugins run
  interpreted and its discovery is irrelevant here; `auth_request` cannot return the login redirect
  without extra machinery; our own proxy puts WebSocket, streaming and HTTP/2 correctness on us.
- **Compile gates into Caddy routes,** normalising the glob or making every rule terminal. Either
  changes the product in the permissive direction to suit a proxy, and normalising still cannot express
  fall-through.
- **Put the installation services on application contracts** (`defineContract` and `implement`).
  Rejected: `boot` deletes the framework variables and binds `@fabrika/db`, and the services would need
  more exceptions than the five installation forms. An installation entry reuses the endpoint table and
  the matcher instead.
- **Keep generated gates for contract applications.** Rejected: an absent credential falls through, so
  a gate can only add access, and the proxy cannot check the caller kind or the requirement.
- **Let the application select the endpoint again from the path.** Rejected: two selections can
  diverge. The application serves the id the proxy selected; its own selection only has to agree.
- **One digest for the whole contract instead of one per endpoint.** Rejected: every endpoint would
  answer 503 during a switch, not only the changed ones.
- **Rely on the private network alone for the hop.** Rejected: every service in a Zerops namespace
  shares that network, so a sibling service could dial the application directly.
- **A proxy secret on Cloudflare too.** Rejected: the service binding already authenticates the hop,
  and the application Worker has no public route.
- **Let cross-application grants enter every application token.** Rejected: a token minted for one
  application would carry authority over others, and the requirement check would pass on a grant the
  application never declared.
- **One IAM application per application, shared by its environments.** Rejected: a staging key or role
  would also work at production.
- **A shared parent-domain session cookie, or every app on one hostname.** The first fails on
  `*.zerops.app` and forces apps under a platform domain. The second breaks routing by `Host` and loses
  cookie and CORS isolation between apps.
- **A separate Cloudflare entrypoint for redemption.** Real churn for little gain; the code's own
  properties stop replay.
