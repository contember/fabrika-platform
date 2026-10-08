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

The code does not do the endpoint-table form yet: the proxy evaluates generated gates for contract
applications (part B, work units B2, B3 and B4).

### 1. Only the proxy is publicly routed

An application service has no public address. On Zerops that is the platform default. On Cloudflare
the app Worker declares no route and sets `workers_dev: false`; the provider refuses the graph
otherwise. It is reachable only through the `APP` service binding of its proxy Worker.

A Zerops namespace is one private network, so a sibling service can still reach an application. On
Zerops the proxy therefore authenticates itself to the application with a **secret per application and
environment** (rule 5). On Cloudflare the service binding is the authenticated hop: the application
Worker has no public route, and nothing else can bind it
([ADR-0048](0048-bind-cloudflare-delivery-to-the-recorded-commit.md)). Cloudflare has no proxy secret.

IAM stays **global**: one identity database, one audit log, one console. The proxy is **stateless**
and per deployment boundary: one per namespace on Zerops, one per app environment on Cloudflare. Only
the cold path calls IAM; the warm path verifies a token locally.

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
3. `reverse_proxy` to the private upstream, with every `__Host-px_*` cookie stripped and the proxy
   secret set. Caddy reads the secret from a managed variable through an `{env.…}` placeholder.

Step 1 must be a delete, not an overwrite: `copy_headers` skips an empty auth-response value, so a
client's own `X-Fabrika-Token` would otherwise reach the app on a `public` path.

**Response headers.** The proxy sets one conservative header policy on every application response and
on its own denials: Caddy through its response operations, the Cloudflare proxy Worker in code, and
`@fabrika/proxy-core` on every denial it answers. An application cannot omit the policy. A download
endpoint gets the file treatment instead. The framework sets the same policy in-process.
Per-endpoint profiles are not part of v1.

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

**Endpoint tables (contract applications).** The manifest carries `{ id, hosts, upstream, endpoints,
snapshot }` per application. Each endpoint row is `{ id, kind, method, path, callers, requirement,
digest }`. Array order has no meaning here. The proxy makes one pass over one selected endpoint:

1. **Canonical path.** The raw path must have no empty segment, no `.` or `..`, no encoded `/` or `\`
   and no trailing `/`. Otherwise the answer is 400. A request without a method is denied.
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
It does not forward a `px_` key or a session that arrives on such a request. Admission still applies:
a form has a body limit and admits only its content type. A webhook's signature is verified by the
framework, not by the proxy.

**Principal kinds.** A `px_` key has its own principal kind. The kinds are `user` and `service`, plus
`link`, `app`, `job` and `webhook`, each added with the feature that needs it. The caller `human`
admits a session or a `user` key; `machine` a `service` key; `link` a `link` key; `app:<id>` the
connector key of application `<id>`, and only on export paths. Job and webhook keys are accepted by no
mount. The proxy refuses an unknown kind, on cached paths too.

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
  the endpoint's kind, method, path, callers, requirement and admission. The application dispatches by
  the id and answers 503 when the digest differs from its own. A request is therefore never served by
  code that expects different rules than the proxy applied.

At startup the application compares its contract digest with `FABRIKA_CONTRACT_DIGEST`, a literal in
the execution descriptor ([ADR-0043](0043-validate-and-render-one-zerops-descriptor-meaning.md)). It
refuses to start on a mismatch.

The publish order stays proxy, application, IAM. Because of the digest check the order is safe in both
directions. During a switch, changed endpoints answer 503 and new endpoints answer 404.

An app owns the check a path gate or an endpoint row cannot make: `can(action, scope)` over an
application-owned object, resolved from validated request data. The framework of ADR-0012 also repeats
the caller-kind and requirement checks. These checks are authorization. They never replace the proxy's
decision, and the proxy's decision never replaces them.

**Invariant: an application issues no credentials.** `@fabrika/auth` has no issuing or redeeming
method. IAM issues every `px_` credential: share links and API keys from its admin surface, machine
keys through `fabrika control key issue`, builder credentials through device authorization
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
- **Delegation grants.** For an endpoint whose action is a dimension's `members.manage`, the proxy
  obtains a single-use grant bound to the endpoint and the request. IAM requires it for membership
  operations, so a handler on another endpoint cannot spend the caller's authority.

The code does none of rule 6 yet (part B, work unit B5).

## Consequences

- **Unreachability is structural**, and one implementation of the security-critical path serves both
  providers. A fix lands once.
- **A narrower endpoint really narrows.** An absent credential no longer falls through to a later rule
  for a contract application. Fall-through stays for installation gates only.
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
  `FABRIKA_IAM_RPC_KEY`, `/auth/mint/*` takes `FABRIKA_IAM_PROXY_KEY`, and an unset key makes its surface
  404. On Cloudflare one IAM `WorkerEntrypoint` implements `IamRpc` and `IamHandoffRpc`, so any holder of
  the `IAM` binding can call `exchangeAuthCode`. We accept this: exploiting it needs a first-party Worker
  with the binding, a live code and that browser's handoff verifier.

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
- **Keep generated gates for contract applications.** Rejected: an absent credential falls through, so
  a gate can only add access, and the proxy cannot check the caller kind or the requirement.
- **Let the application select the endpoint again from the path.** Rejected: two selections can
  diverge. The application dispatches by the id the proxy selected.
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
