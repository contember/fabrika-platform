---
id: 0022
title: The proxy is the only enforcement point
status: accepted
date: 2026-10-20
---

# 0022 — The proxy is the only enforcement point

## Context

An application that enforces its own authentication is only as safe as its wiring. A route registered
before the middleware, a second entrypoint or a forgotten mount is an unauthenticated path. If the app
is also publicly routable, "the app forgot to check" and "the world can reach it" are the same
deployment. Cloudflare Access solves this on Cloudflare only; fabrika also runs on Zerops.

The enforcement point has two different jobs. **HTTP correctness** (WebSockets, streaming bodies,
HTTP/2, hop-by-hop headers, timeouts) is subtle and app-visible when wrong. **Authorization** (the
endpoint decision, token minting and verification) is the security-critical path and exists in TypeScript.
Cloudflare does the first job for a Worker. Zerops needs a real reverse proxy, and Caddy's
`forward_auth` calls an external service and either forwards the request with copied headers or
returns the service's own response (a redirect to login works unchanged).

Endpoint selection does not map onto Caddy's route matchers. Checked against Caddy v2.10.2:

- **The decision needs facts a matcher cannot know.** Which credential a request carries, its caller
  kind and whether its token satisfies the endpoint's requirement are known only after the credential
  is read and, on the cold path, after an IAM call. A matcher decides before either is known.
- **Caddy's path matcher is case-insensitive**; the endpoint matcher is not. `/API/rpc` would match an
  `/api/rpc` route in Caddy.
- **Caddy merges `//` before matching**; the endpoint matcher reads the raw path and refuses a
  non-canonical one.

The last two fail silently: a second evaluator decides a slightly different set of requests than the
application declared, in the permissive direction.

Browsers also constrain how a session reaches an app. `*.zerops.app` is on the Public Suffix List, so
a cookie scoped to a parent domain is refused there, and a platform that hosts apps on their own
domains cannot require them to share one with IAM.

An application declares its whole access surface in one contract
([ADR-0012](0012-fabrika-app-runtime.md)), and Fabrika deploys no application without one
([ADR-0050](0050-approved-access.md)). The enforcement point must decide from that contract, not from a
looser summary of it:

- **Each endpoint has its own rules.** A narrower rule for one endpoint must narrow it. A request must
  never reach a broader rule because its credential is absent.
- **The requirement belongs to the decision.** The caller kind, the action an endpoint requires and
  whether a request is a cross-site write are known from the contract. If only the application checks
  them, the check sits inside the process an agent can edit.
- **The hop to the application must be authenticated.** A service in the same Zerops namespace can dial
  the application directly, and the application must be able to tell that the proxy applied the rules
  it expects.

The installation's own services (IAM, Control, Operations) need the same decision, plus a few forms an
application must never have: a protocol the service authenticates itself, any method on a path, and an
OAuth resource token.

## Decision

**We will make the proxy the single enforcement point for every request to every application.** Six
rules.

Every entry of a proxy manifest is an endpoint table, in exactly one of two forms:

- An **application table** protects a contract application. Producers compile it from the approved
  contract with `contractProxyTable` (`ContractProxyApp`).
- An **installation entry** protects one of the installation's own services. Producers compile it from
  the service contract with `serviceProxyTable` (`InstallationProxyApp`, `installation: true`). Only
  trusted platform composition writes one, and it may use five forms no application may declare
  (rule 3).

**There is exactly one evaluator: the endpoint decision of `@fabrika/proxy-core`, over the planner of
`@fabrika/auth-core` (`planEndpoint`), and only the proxy runs it.** It makes one pass over one selected
endpoint. Two other layers refuse requests and are not the enforcement decision:

- **Authorization** — `.require`, `can()`, a contract application's caller-kind, requirement and
  access-form checks, and Control's scoped use-case checks (rule 5).
- **Admission** — the proxy's `Sec-Fetch-Site` and content-type checks (rule 3, step 6) and its answer to a
  cross-origin request (rule 3, "Cross-origin endpoints", with the browser admission matrix). They resolve no principal and read no policy. Control
  reads no `Origin`, and IAM's `/admin/*` is bearer-only.

`docs/reference/overview.md` defines all three; keep the vocabulary.

### 1. Only the proxy is publicly routed

An application service has no public address. On Zerops that is the platform default. On Cloudflare
the app Worker declares no route and sets `workers_dev: false`; the provider refuses the graph
otherwise. It is reachable only through the `APP` service binding of its proxy Worker.

A Zerops namespace is one private network, so a sibling service can still reach an application. On
Zerops the proxy therefore authenticates itself to the application with a **secret per application and
environment** (rule 5). On Cloudflare the service binding is the authenticated hop: the application
Worker has no public route, and nothing else can bind it
([ADR-0048](0048-bind-cloudflare-delivery-to-the-recorded-commit.md)), so the proxy Worker sends no proxy secret. The
application Worker forwards each request to its environment's Durable Object with the secret, which the object
verifies, because any Worker on the account can bind an exported object class
([ADR-0065](0065-an-application-on-cloudflare-runs-in-one-durable-object-per-environment.md)).
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
same `@fabrika/proxy-core` code in-process. Caddy's admin API is disabled; the manifest is baked into
the deploy artifact.

The Caddy configuration is a **fixed chain per app**, identical whatever the endpoint table says:

1. **Delete** the headers a client must not assert — every hop header in `FABRIKA_HOP_HEADERS`, the request
   id, the client address and the forwarding headers — and set the client address from Caddy's own
   `client_ip`. That one list in `@fabrika/auth-core` feeds this step and the Cloudflare proxy Worker. It
   is not every `X-Fabrika-*` name: the Operations upload headers pass to Operations.
2. `forward_auth` to `/verify?app=<id>`. The app id is pinned in the route, never derived from a
   client-influenced header.
3. `reverse_proxy` to the private upstream, with every `__Host-px_*` cookie stripped and, for an
   application, the proxy secret set. Caddy reads the secret from a managed variable through an
   `{env.…}` placeholder.

Step 1 must be a delete, not an overwrite: `copy_headers` skips an empty auth-response value, so a
client's own `X-Fabrika-Token` would otherwise reach the app on an anonymous endpoint.

**Response headers.** The proxy sets one conservative header policy on every response of a contract
application and on its own denials: Caddy through its response operations, the Cloudflare proxy Worker
in code, and `@fabrika/proxy-core` on every answer it writes. The proxy **replaces** whatever the
application set for these names, so an application can neither omit nor weaken the policy. The
framework sets the same policy in-process; both read the one definition in
`@fabrika/proxy-core/headers`. An answer that belongs to no contract application (the denial of an
installation entry, a forward refused before an app is selected) carries the policy without named
origins; an installation service's own answers pass through unchanged, because IAM and
Control set their own per-response CSPs for login, consent and their console flows. Per-endpoint
profiles and caching of static assets are not part of v1.

The proxy also **deletes** four headers an application may not send at all, on every answer and every
download: `Content-Security-Policy-Report-Only`, `Report-To`, `Reporting-Endpoints` and `NEL`. Each names
a reporting endpoint the policy never approved, and a report-only CSP reports the document and blocked
URLs there whatever the enforced CSP says. A `1xx` answer of the application (`103 Early Hints`) leaves
the proxy with no header at all: Caddy forwards it before its response operations run, so a deferred
handler around the upstream clears it, and an application cannot preload a script or send a policy
through it. The Cloudflare runtime does not hand a Worker a `1xx` answer. When the application binding
fails, the Worker answers a fixed `502` with the same treatment, never the error; Caddy's own failures
(an upstream it cannot dial) get it through the server's error routes.

**HSTS** follows the manifest scheme: every answer of an `https` application host, downloads, redirects and
the proxy's own failures included, carries `Strict-Transport-Security: max-age=31536000`, and an `http` host
(the local stack) none. Only the proxy knows the public scheme, so the framework's in-process policy has no
transport header. No `includeSubDomains` and no `preload`: applications share parent domains. A refusal before the
request is read (a non-canonical path, a missing method) carries the base policy and the transport header of the
host it names; the Cloudflare Worker's 503 when it cannot initialize carries the named host's treatment. The
application's own `Strict-Transport-Security` never passes: an `https` policy replaces it, and on an `http` host it
is deleted. An answer that belongs to no application host carries none.

The policy:

- `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
  img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' <operations ingest>;
  form-action 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`. `<operations ingest>`
  is the installation's Operations ingest origin; the framework takes it from `FABRIKA_OPERATIONS_DSN`,
  and the proxy from its manifest entry's `operationsOrigin`, the origin of the same DSN: the Cloudflare
  provider reads it from the run's managed environment, and on Zerops Control hands it to each namespace
  member (`ProviderNamespaceMember.operationsOrigin`). The DSN's key never reaches a manifest. The
  contract may extend `connect-src`, `img-src`, `frame-ancestors`, `script-src`, `frame-src`, `style-src`
  and `font-src` with named origins (a hosted typeface names its stylesheet and its font origin) — exact `https://` origins with a literal host, never a pattern, at most 16 per directive
  (`MAX_CSP_ORIGINS`, checked by the contract build and the manifest parser); such an extension is
  approvable ([ADR-0050](0050-approved-access.md)). `frame-src` appears only when it names an origin, and then as
  `frame-src 'self' <origins>`: without it frames fall back to `default-src 'self'`, so an extension never
  takes the same origin away and removing the last one narrows. A
  challenge provider of a public procedure (or of a 0.4/0.5/0.6 form) adds its own fixed origins to `script-src` and
  `frame-src`, which the approval diff shows like any other. ALTCHA, which the application issues itself, adds no
  origin: its widget is bundled with the page and solves in workers it starts from `blob:` URLs, so the build writes
  `workerSrc: [blob:]` and the policy gains `worker-src 'self' blob:`. Only that source exists there, the contract
  cannot declare it, and a manifest without it carries no `workerSrc` key, so an older proxy still parses every other
  application's entry and refuses the one that needs the directive rather than serve it without.
- `X-Content-Type-Options: nosniff`.
- `Cache-Control: no-store`, static assets included. The one exception is a public `GET` query that declares
  `http.cache`: its row carries `cache`, and a `200` answer gets `Cache-Control: public, max-age=<n>` or
  `public, max-age=31536000, immutable` instead. An error or a redirect keeps `no-store`. The framework, the
  Cloudflare proxy Worker and Caddy apply the same header values (`@fabrika/proxy-core/headers`).
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

An endpoint that answers a stored file gets the **file treatment** instead. The proxy recognises it by the row the
decision selected, never by a path of its own: a procedure whose output is a file carries the **file-response
profile** (`response: 'file'`) in its row and in the row's digest
([ADR-0061](0061-a-file-is-a-value-in-a-table-column.md)), and a 0.4/0.5/0.6 collection's `download` row is one by its
kind. The application applies the same treatment from the row, denials included. An older proxy's strict parser
refuses a row with the profile instead of serving it without the treatment.

- `Content-Disposition: attachment` for every type except the inert images `image/png`, `image/jpeg`,
  `image/gif` and `image/webp`, which are served `inline`. SVG and HTML are always attachments. The
  proxy sets the disposition type from the answer's exact `Content-Type` and keeps its parameters
  (the file name). `inline` needs exactly one `Content-Type` value from that list: repeated fields are
  joined into one value first, which no listed type equals, so any duplicate is an attachment.
- `Content-Type` from the recorded, sniffed type, never from the upload request.
- `X-Content-Type-Options: nosniff`.
- `Content-Security-Policy: sandbox; default-src 'none'`.
- `Cache-Control: private, no-store`, so a revoked user cannot read a cached copy, unless the row declares `cache`
  (a public file, such as a catalog image).
- `Strict-Transport-Security` on an `https` host, as above.

**Invariant: a header a client can set never reaches a decision.**

**Invariant: fabrika browser credentials terminate at the proxy.** The app receives the verified token
header and its own cookies, never a fabrika session or handoff cookie. The one exception is the
platform proxy's route to IAM, which keeps IAM's own login cookie.

### 3. The endpoint decision is made once, in TypeScript, by the proxy

An endpoint row never compiles into a route matcher, a firewall rule or any other engine's
configuration. The proxy receives the endpoint table verbatim in its manifest and decides with the
canonical matcher in `@fabrika/auth-core`.

**The manifest parser is strict.** An entry parses as an application table or as an installation
entry, and as nothing else. It refuses an unknown key — `gates` among them — instead of ignoring it.
Besides its entries a manifest carries one presentation field, `brand`, the installation's client logo
([ADR-0066](0066-the-installation-shows-its-clients-logo.md)). No decision reads it; only the proxy's pages draw it.

**Application tables.** The manifest carries `{ id, hosts, upstream, scheme, endpoints,
reservedPrefixes, snapshot, csp, operationsOrigin?, crossOrigins? }` per application; `snapshot` is the contract
digest, `csp` the contract's named origins and `crossOrigins` the environment's. Each endpoint row is `{ id, kind,
method, path, callers, requirement, admission, delegation, crossOrigin?, response?, cache?, authorization?, digest }`,
and the manifest parser refuses a row whose digest does not describe its rules. `response`, `cache` and
`authorization` are absent unless declared, so every other row keeps its digest. Array order has no meaning. The proxy makes one pass over one selected
endpoint:

1. **Canonical path.** The raw path must have no empty segment, no `.` or `..`, no encoded `/` or `\`
   and no literal `\`. Otherwise the answer is 400. A request without a method is denied. A trailing
   `/` is significant and matched literally: `/a/` and `/a` are different paths.
2. **Selection.** `planEndpoint` selects the most specific endpoint: a literal segment beats a
   parameter, and a parameter beats a wildcard. An RPC prefix is reserved for its procedures. No
   endpoint is a 403 (`no_endpoint`). There is no fall-through to another endpoint.
3. **A `px_` key is present.** The proxy mints from it with `mintFromKey`. The key's principal kind must
   be one of the endpoint's callers. This step is terminal: a rejected key never falls back to a
   session. The key never reaches the application: on the allow, the proxy replaces the request's
   `Authorization` with `Bearer <the minted token>`, the value it also sends as `X-Fabrika-Token`. A key
   bound to no application would otherwise let the application act as its principal at any other
   application (rule 6). A request without `Authorization`, a session's, gains none, because the
   application tells a bearer from a session by the header's presence.
4. **No key.** When `human` is a caller, the proxy uses the session, or answers with the login
   redirect of rule 4. When `human` is not a caller, the answer is 401, never a login redirect.
5. **Requirement.** The token must satisfy the endpoint's requirement: `member` (any permission of this
   application), the action in some scope, for the `app` access form the action held as a global grant (an
   entry without a scope), because the endpoint reaches data of the whole application, and for `capabilities` each of
   its actions in some scope ([ADR-0012](0012-fabrika-app-runtime.md) §10). Otherwise the answer is 403. A
   `capabilities` requirement derives no delegation.
   This is `satisfies` of `@fabrika/auth-core`; the application repeats it as authorization and adds no check.
6. **Admission.** A session-authenticated request that is not `GET` must carry
   `Sec-Fetch-Site: same-origin`. A request with a body must carry one of the row's declared content types:
   `application/json` by default, `multipart/form-data` for a procedure with file fields, and
   `application/x-www-form-urlencoded` for one that declares it. A request with a bearer is not session-authenticated, cookie or
   not: a page cannot attach `Authorization` to another site's request without a preflight, and the proxy
   answers one only for an origin the environment lists on an endpoint the contract opens ("Cross-origin
   endpoints" below), so a bearer is explicit authority and needs no `Sec-Fetch-Site`.

**Anonymous kinds.** An endpoint of an anonymous kind (`c.health`, `app.webhook`, the shell of a link SPA, a public
SPA, `c.spa` with `access: { public: true }`, a public procedure, and a 0.4/0.5/0.6 `c.form`) has no callers. The proxy
skips steps 3 to 5, mints no token and forwards the request. It does not forward a `px_` key or a session that arrives
on such a request; only an installation entry's `protocol` row keeps the `Authorization` header (below), and a webhook
row that declares `authorization: 'forward'` keeps the sender's own. Admission
still applies: the row admits only its content types, and a body a browser sends without a preflight is refused from
an origin the row does not admit (the browser admission matrix below). The body limit is the framework's, because
`forward_auth` hands the proxy the headers and never the body. A webhook's signature is verified by the framework,
not by the proxy.

**A webhook's own `Authorization`.** A webhook whose verifier compares `Authorization` with its binding's secret
(`{ basic: true }`, `{ bearer: true }`, [ADR-0012](0012-fabrika-app-runtime.md) §13) compiles to a row with
`authorization: 'forward'`; only a `webhook` row may declare it. On that row the decision keeps the request's
`Authorization` for the application and never reads it: no key lookup, no session, no token. It still removes a value
that carries a `px_` key, as the header or inside Basic credentials, because a platform key sent to a webhook URL by
mistake must not reach application code; a binding's secret therefore never contains `px_`. The decision signals the
outcome on its 2xx with `X-Fabrika-Forward-Authorization: 1`. Each deployment (Caddy's chain, the Cloudflare proxy
Worker, the test kit) forwards `Authorization` unchanged when that marker is present, deletes it from an allow that
carries no token, replaces it with the minted token on an allow that carries one (step 3), and passes the marker on
to no one. The field is new: an older proxy's strict parser refuses the row, so a Zerops namespace
pinned to an older proxy source refuses that deploy
([ADR-0062](0062-a-platform-release-serves-older-framework-releases.md)).

A **public procedure** ([ADR-0063](0063-a-public-procedure-runs-as-its-own-workload.md)) compiles to its own row kind,
`public`: no callers, no requirement, no delegation, and every credential discarded, on any mount. The kind is new, so
an older proxy's strict parser refuses the manifest instead of serving the row without its admission rules. The
handler holds what IAM signs for the endpoint's own workload key, never anything of the caller. The proxy sets
`X-Fabrika-Client-Ip` where it knows the visitor's address (the Cloudflare proxy Worker today), and the application
reads it as information.

**Cross-origin endpoints.** Applications are isolated from each other by their own hosts, host-only cookies and
the absence of CORS. A page on another origin calls an application's endpoint only where two separate facts allow
it, and the proxy decides both:

- **The contract opens the endpoint.** A procedure of a `c.rpc` mount declares `admission: { origins: 'listed' }`, and
  a public procedure may instead declare `origins: 'any'`. The artifact records it on the row as
  `crossOrigin: 'environment'` or `'any'`, only when declared, so every other row and contract keeps its digest. A
  0.4/0.5/0.6 procedure's `crossOrigin: true` and a form's `crossOrigin: true | '*'` compile to the same two values. The
  row's digest covers it, and an approval shows it like any other change of the access surface
  ([ADR-0050](0050-approved-access.md)). No other kind may declare it: a link procedure, an export, an SPA, a
  download, an upload, a webhook and a health endpoint are refused by the contract build, the artifact schema and the
  manifest parser. `'any'` is for an anonymous row only.
- **The environment names the origins.** Which pages may call differs between staging and production, so the
  origins are a fact of the environment, not of the contract. Control keeps them in the environment's registry row,
  beside its domain (`fabrika control register` or `fabrika control apps environments put` with `--cross-origin=<origin>`,
  repeatable), and whoever holds `app.manage` on the application sets them, not the repository. That includes the
  builder key of a local agent ([ADR-0042](0042-connect-local-builders-through-human-consent.md)). Each is an exact `https://` origin with a literal host (`http://` for a local
  host), never the environment's own domain, at most `MAX_CROSS_ORIGINS` (16). Control hands them to the provider,
  which writes them into the application's manifest entry as `crossOrigins`; the manifest parser refuses a malformed
  one and the entry of an installation service carries none. An `environment` row of an environment that
  lists no origin answers no preflight, as before. A change of the list applies at once and is not approval-gated, on
  a protected environment too, because a listed origin grants no authority: its requests are bearer-only (rule 3
  below). The page of an approval that waits for a decision names the list beside each line that opens an endpoint
  to it, a decided approval names none, and the environment page shows it ([ADR-0050](0050-approved-access.md)).

The proxy then decides, in the same pass as every other request of a contract application:

1. **A preflight is decided before the caller step.** An `OPTIONS` request with `Origin` and
   `Access-Control-Request-Method` is planned against the table for the requested method and path, with no
   fall-through. When the selected row is `environment` and the origin is listed, or the row is `any`, the proxy
   answers `204` itself with `Access-Control-Allow-Origin` (the origin, or `*` for `any`), `Access-Control-Allow-Methods`
   (the row's method), `Access-Control-Allow-Headers: Authorization, Content-Type`, `Access-Control-Max-Age: 600` and,
   for a listed origin, `Vary: Origin`. Otherwise the answer is 403, as today. A preflight carries no credential, so
   no caller, requirement or admission check runs on it, and it never reaches the application. Any other `OPTIONS`
   request selects no row and is 403.
2. **The answer is decorated.** Every answer to a request whose `Origin` is admitted that way, the application's and
   the proxy's own denials alike, carries `Access-Control-Allow-Origin` and, for a listed origin, `Vary: Origin`. No
   answer ever carries `Access-Control-Allow-Credentials` or `Access-Control-Expose-Headers`.
3. **Bearer only.** A request from a listed origin to an `environment` row is never session-authenticated: without
   `Authorization` it is 401 (`no_credential`), never a login bounce, and the session cookie is not read. Without
   `Allow-Credentials` the browser would not expose such an answer anyway; the proxy ignoring the cookie is the second
   guard. The caller is a `px_` key: an application row admits no OAuth resource token, so the question of OAuth
   callers does not arise here. The `cross_site` rule of step 6 is unchanged for every other request.
4. **The application answers nothing about CORS.** The proxy deletes every `Access-Control-*` header from a contract
   application's answer (`REMOVED_RESPONSE_HEADERS`), so a handler cannot open its own endpoint to another origin,
   and the framework does the same in-process. On Zerops the auth service tells Caddy which origin to admit, and
   Caddy writes the preflight's `204` and the decoration from that answer; Caddy's configuration names no origin and
   decides nothing.
5. **A body sent without a preflight is refused from an origin the row does not admit, at the request.** A browser
   sends `multipart/form-data` and `application/x-www-form-urlencoded` from any page without a preflight. On a public
   row such a request, and any request to a 0.5.5 form row that admits `multipart/form-data`, whose `Origin` is neither
   the application's own (`<scheme>://<host>` of the entry) nor admitted by the row is 403 `cross_origin`, before it
   reaches the application: what the preflight refuses for a JSON body. A request without `Origin` passes, as a
   script's request does; `Origin: null` names no origin and is refused. The application does not repeat the check; it
   does not know the environment's origins.

**The browser admission matrix.** Together, steps 6 above and the items above admit a browser's request as follows.
The proxy enforces every row but the last, which needs the application's token keys:

| Request                                          | Rule                                                                                                                                 |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Session, non-`GET` (any body codec)              | `Sec-Fetch-Site: same-origin`                                                                                                        |
| Session, `GET`                                   | a query only: a session mutation is never `GET`                                                                                      |
| Bearer, cross-origin                             | the proxy's preflight for an `environment` row and a listed origin; never a session                                                  |
| Public, multipart or `urlencoded` (no preflight) | `Origin` must be the application's own, a listed origin (`environment`) or any (`any`); no `Origin` passes, `Origin: null` does not  |
| Public, `GET` mutation                           | in the application: a valid signed token in the input, verified as the input is parsed ([ADR-0012](0012-fabrika-app-runtime.md) §14) |

Operations' error ingest keeps its own `Access-Control-Allow-Origin: *` on preflight-free simple requests: it is an
installation service's `protocol` row, which authenticates itself, and an installation entry has no cross-origin
form.

**Principal kinds.** A `px_` key has its own principal kind. The kinds are `user` and `service`, plus
`link`, `app`, `job`, `webhook` and `public`, each added with the feature that needs it. The caller `human`
admits a session or a `user` key; `machine` a `service` key; `link` a `link` key; `app:<id>` the
connector key of application `<id>`, and only on export paths. Job, webhook and public keys are accepted by no
mount. The proxy refuses an unknown kind, on cached paths too. An OAuth resource token is no `px_` key:
`callerOf` maps it to the caller `oauth`, which only an installation entry's row may admit, so every
application endpoint refuses it.

A workload token carries its kind in `ptype` and names its workload in `workload`: the job's or the
webhook's name, a public procedure's endpoint id, or for `app` the consuming application's id. `callerOf` maps `app`
to `app:<workload>` and `job`, `webhook` and `public` to no caller; `callerAdmittedAt` admits `app:<id>` only under
`/__fabrika/connect/`. The caller `machine` refuses a workload token too, and neither `@fabrika/auth` nor
IAM's management and membership operations accept one, with one exception: a **job** that the approved contract
declares `issues: '<link mount>'` calls `issueLink` for that mount and `revokeLink` for a link it issued. The schema
reconcile records the mount with the job (`AppSchema.workloads[].issues`, from the approved artifact); IAM reads that
declaration at every call and refuses a job without it, another mount, another application, and every webhook,
public or connector token. The job holds the mount's `issuedBy` and grants app-wide, so it issues for any object of the
mount's dimension: the link is bound to one object, the job is not. IAM stores a workload principal as a `service`
row whose `workload_principals` row names its kind. A workload key resolves to exactly the actions the
reconciled schema declares for the workload (`AppSchema.workloads`, app-wide), never to a grant, and a
reconcile that no longer declares the workload revokes its keys. Control issues one key per job, per
webhook and per public procedure of the approved contract (`workloads.issueKey` on IAM's admin RPC, with the
provisioning key), seals it in its vault and writes it as `FABRIKA_<KIND>_<NAME>_KEY`, or for a public procedure as
`FABRIKA_PROCEDURE_<ID>_<8 hex of the id's SHA-256>_KEY`; it rotates a key
once less than half of its 30 days is left. Each issuance names the key Control recorded as active, and IAM revokes
every other key of the workload but the new one, so the running version keeps its key until Control records the
replacement. A workload principal resolves no grant and can be given none, and the schema reconcile refuses a public
workload whose action an application role grants.
The application exchanges its own job, webhook or public procedure key at `POST /auth/workload/token` on IAM's public
origin, which signs only for a workload key of the named application: it checks the key's format and the per-client
bucket before any lookup, answers every other key the same `invalid_key`, and answers a storage failure 503.

A connector key is an `app` workload of the **owner**: the owner's schema declares each consumer of its exports,
named by the consumer's id, with the actions of the export rows it may call. An export row admits its consumers'
`app:<id>` and nothing else, and no other row may name `app:<id>`. Control computes the edges from both approved
snapshots: `(shop, prod) → (catalog, prod, products@1)` joins a consumer's import and the owner's export in the
environment of the same name. For each owner a consumer environment imports from, Control issues one key at
`<owner>@<env>` naming the consumer, with the same `keep` rule, and writes it as each import's
`FABRIKA_CONNECT_<IMPORT>_KEY`, with the owner environment's `https://<domain>` as `_URL`. When the consumer drops
its last import of an owner, Control revokes every key of the pair at IAM before it forgets the record. An export
procedure names its action; `member` would leave the consumer's key nothing to hold. The consumer presents the key
to the owner's proxy, which exchanges it like any `px_` key. On Cloudflare the deployer also binds
`FABRIKA_CONNECT_<IMPORT>` to the owner's proxy Worker; it is the only binding to another application's Worker.
A publication that breaks an edge fails, approved or not: a consumer import must be exactly the owner's approved
export (its digest) and name only procedures it has, and an owner deploy may not remove an export version an approved consumer imports, stop naming
that consumer, remove an imported procedure, accept less input, change an output or change the audience. A new
procedure, a new optional input field and a new version are compatible; an output may not gain a field, because a
consumer parses every answer strictly.

**Installation entries.** An endpoint table that protects one of the installation's own services (IAM,
Control, Operations) is a manifest entry `{ id, hosts, upstream, scheme, installation: true, endpoints, reservedPrefixes,
oauthResources? }`. The marker comes from trusted platform composition — the installation's platform
proxy manifest and its Cloudflare proxy Workers — never from the shape of an id; that the id holds no
`@` is only a consistency check. Such an entry has no contract, so it carries no `snapshot`, no `csp`, no
`operationsOrigin` and no `crossOrigins`. Its rows are `{ id, kind, method, path, callers, requirement, admission,
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
The parser reads an entry without `installation: true` as an application table, whose rows admit none of
the forms. It refuses an installation entry whose id holds `@`, that carries `snapshot`, `csp`,
`operationsOrigin` or `crossOrigins`, or whose `oauth` row has no registered resource on its path or asks for a scope the
resource does not support.

**The hop of an installation entry.** The proxy keeps `Authorization` on the upstream hop, sets no proxy
secret and sets no response policy; its own denials carry the base policy. It copies
`X-Fabrika-Endpoint` to the service. Before it selects an endpoint, the proxy answers the entry's
RFC 9728 metadata paths and the handoff callback.

**Reserved prefixes of a service.** A service table reserves the prefixes of its mounts, as a contract
reserves its RPC prefixes. Under a reserved prefix only the rows declared under it compete. The console
reserves `/webhooks` and `/mcp` among others, so no path under them reaches the console's SPA row: the
proxy refuses a path that no row under the prefix serves. The prefix path itself is a row of its own:
the service answers 404 on `/webhooks`, and on `/mcp` when MCP is off.

A service with more than one table — the console, whose `/mcp` row admits `oauth` only when the installation
registers an authorization server for its resource — learns which one its proxy publishes from one composition
value, `FABRIKA_SERVICE_TABLE_DIGEST`: `installationTableDigest` of the published table, over each row's id and
digest and the reserved prefixes. The composition writes it from the manifest it gives the proxy. The service
refuses to start when the value is missing or names no table it serves, so a disagreement fails the deploy instead
of answering 503 at runtime.

The requirement check is part of the proxy's decision whether a request reaches the application, and
the proxy runs the admission checks in the same pass. The requirement reads only the token; it needs no
application-owned object. The application repeats the caller and requirement checks as
**authorization** (rule 5).

**Invariant: every unexpected condition denies.**

**Invariant: a decided negative and an unreachable IAM are different denials.** A bad credential is a
401/403. "We could not check" is a 503, and a 503 never degrades into a bounce to login.

### 4. A session reaches an app through a one-time code the proxy redeems

On an endpoint whose callers include `human`, when the request carries no key and no usable session,
the proxy answers with the login URL: a **302** for a document navigation, a **401** with
`{ error: { type, message, loginUrl } }` otherwise. The signal is `Sec-Fetch-Mode`, which the browser
writes and page script cannot. An absent value reads as a navigation.

IAM authenticates the human, issues a single-use code bound to `(session, app, return URL)`, and
redirects to `/__fabrika/auth/callback` on the app's own host. The proxy answers that path before it
selects an endpoint, redeems the code with IAM, sets the returned **child app session** as a host-only
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
[ADR-0040](0040-share-one-token-verifier.md) and builds the `AuthContext`. It makes no enforcement
decision, exchanges no session, writes no cookie and issues no login bounce. Verifying the audience keeps a token
minted for another app out.

For a contract application, the hop carries more facts, and the application checks them:

- **The proxy secret, on Zerops.** The application checks it before anything else and refuses a
  request without it. A direct dial inside a Zerops namespace therefore gets no answer from application
  code. Control generates the secret per application and environment and writes it as a managed
  variable to the proxy and to the application. On Cloudflare the service binding takes its place between the
  proxy and the application Worker, and the application Worker sends the secret on its hop to its Durable Object
  (rule 1).
- **The endpoint.** The allow response carries `X-Fabrika-Endpoint: <id>@<digest>`. The digest covers
  the endpoint's kind, method, path, callers, requirement, admission, delegation, cross-origin form, file-response
  profile and cache. The application serves the
  endpoint the id names, and only when its own `planEndpoint` selects the same endpoint and the digest
  equals its own; a missing header or any disagreement is a 503. A request is therefore never served by
  code that expects different rules than the proxy applied. A health endpoint alone may arrive without
  the header, because the platform's liveness probe dials the application directly.

An installation service checks the endpoint as well, with one stated exception: it requires the header
on its credentialed rows only. A `protocol` or `health` row may arrive without it, because the service
authenticates such a request itself, and such requests also arrive unfronted — at IAM's own Worker on
Cloudflare, and over the private hops between the services.

An installation service gets no proxy secret, with one exception for attribution. On Zerops IAM keys its per-client
login throttle on `X-Fabrika-Client-Ip` and writes `X-Request-Id` to `auth_log` and `audit_events`, and anything on
the platform project's private network can reach IAM's port and write both. So Caddy sets `X-Fabrika-Proxy-Secret`
on the route of IAM's session owner, from `FABRIKA_INSTALLATION_PROXY_SECRET_IAM`, and IAM holds the same variable.
IAM reads the two headers only from a request whose secret matches (digests compared in constant time). Any other
request shares one client bucket and gets a generated request id. A missing secret is never a refusal by itself;
the shared bucket refuses once it is exhausted, like the balancer's one bucket every Zerops client shares today. This
is attribution, not a second enforcement decision. `platform deploy` derives the secret as HMAC-SHA256 of the label
`fabrika-installation-proxy-secret:iam` keyed by `FABRIKA_IAM_PROVISIONING_KEY`, which every deploy already holds,
and writes it sensitive to `proxy` and `iam` on every deploy without reading it back. It is not derived from the
proxy key, because every namespace proxy holds that one. An unset variable turns IAM's check off: Cloudflare, where
IAM's Worker sits behind Cloudflare's edge and reads `CF-Connecting-IP` and `cf-ray`, sets none.

Work unit B3 built the hop. `FABRIKA_HOP_HEADERS` in `@fabrika/auth-core` is the one list of every
`X-Fabrika-*` name a hop carries; Caddy and the Cloudflare proxy Worker delete exactly it. The secret
travels as `X-Fabrika-Proxy-Secret`. Control seals it in its vault the first time an environment
joins a namespace proxy, or is deployed by a provider that declares `applicationHopSecret` (Cloudflare), and never
rotates it on its own. The proxy service holds one variable per
application, `proxySecretVariable('<app>@<env>')`, because one proxy fronts a whole namespace; the
application holds `FABRIKA_PROXY_SECRET` and compares digests in constant time. The Bun adapter refuses to
start without it, and so does the Cloudflare object. No authored variable may reference a framework-only variable, so the secret cannot be
copied into one the application controls, and Control redacts it from run logs. A health
endpoint is served without the secret, for the same reason it may arrive without the endpoint
header. The Operations upload headers are not hop headers: a client sends them to Operations
through the platform proxy.

At startup the application compares its contract digest with `FABRIKA_CONTRACT_DIGEST`, a literal in
the execution descriptor ([ADR-0043](0043-validate-and-render-one-zerops-descriptor-meaning.md)). It
refuses to start on a mismatch.

Within one application's publish the order stays proxy, application, IAM. Because of the digest check that order is
safe in both directions for a change of endpoint rules. During a switch, changed endpoints answer 503 and new endpoints
answer 404. The digest does not cover the claims a token carries, so a framework version that requires a new claim is
an exception with its own order: the `email` claim of a user token (rule 6) is one.

**The caller document is information, not a decision.** Every member SPA answers `<prefix>/__fabrika-me.json` under
the mount's own access, from the token the proxy injected and nothing else: the person's label and mailbox, the
actions held as global grants, and each scope value with its actions, a pattern grant listed as the contract's actions
it covers. A page greets the person and shows or hides controls by it; every endpoint still decides on its own. A
public SPA answers it 401: the proxy forwards no token to an anonymous kind, so the application cannot tell a signed-in
visitor from an anonymous one.

An app owns the check an endpoint row cannot make: `can(action, scope)` over an
application-owned object, resolved from validated request data. The framework of ADR-0012 also repeats
the caller-kind and requirement checks. These checks are authorization. They never replace the proxy's
decision, and the proxy's decision never replaces them.

**Invariant: an application issues no credentials.** `@fabrika/auth` issues and redeems nothing.
IAM issues every `px_` credential: share links on an application's request, checked against its
caller's live permissions or, for a job, its approved declaration ([ADR-0012](0012-fabrika-app-runtime.md)), share links and API keys from
its admin surface, machine keys through `fabrika control key issue`, a job's and a webhook's key and an application
environment's membership transport key through Control's reconcile, builder credentials through device authorization
([ADR-0042](0042-connect-local-builders-through-human-consent.md)). IAM signs an access token only from a session (`mintToken`)
or a `px_` credential (`mintFromKey`); there is no free-standing signed token to present.

**Invariant: an application has no local authentication variant.** `createIam` requires the binding
and the issuer everywhere. The one dev bypass belongs to IAM: a login that requires `ENVIRONMENT=local`
and `LOCAL_DEV_LOGIN=true`. No environment admits a credential-less caller.

**Invariant: IAM's `/admin/*` is bearer-only.** It accepts the proxy token Control's console gateway
forwards as a bearer (its audience must be a registered admin gateway) or a `px_` key, and reads no
session cookie. Admission for the console is the proxy's (rule 3, step 6); neither Control nor IAM keeps an
origin check. This relaxed Control's own guards for a bearer, which we accept: before, the Operations gateway and
the GitHub connection mutations refused a bearer without the console's `Origin`, and the IAM gateway refused a
bearer beside a cookie. A bearer is explicit authority, so none of these refusals stopped a forgery. An approval
still refuses any `Authorization` header, as authorization.

### 6. An application token is minted for one application in one environment

- **The IAM application id carries the environment:** `<app>@<env>`, for example `notes@prod`. `@` is
  reserved in application ids. One helper in `@fabrika/auth-core` builds and parses the id. The proxy
  mints for that id, and Control registers schemas, return origins and keys under it. A staging key is
  therefore refused at production.
- **An application token carries only grants of that application id.** Cross-application grants and
  the bootstrap `admin` grant reach only a registry of platform audiences, separate from
  `adminAudiences`.
- **An application token cannot call `issueKey`, `revokeKey` or `listPrincipals`**, on any transport.
- **A user token carries the person's mailbox.** Beside `label`, the address as the person or an administrator spelled
  it, a token of `ptype: 'user'` carries `email`: `principals.email`, normalized, on a session's token and a user key's
  alike. The framework hands it to a handler as `ctx.principal.email`, the one address a "send it to me" action
  mails; a service, workload or link token carries none, and the parser refuses one there. It is the mailbox IAM
  recorded for the principal, authenticated by the token's signature; it is no proof that the person controls the
  mailbox, which IAM establishes only as far as its login method does (an IdP configured to accept an unverified
  address, an administrator who hands over an enrollment link). A contract application refuses (401) a `human` token
  without it. **Rollout:** upgrade IAM first. The parser still accepts a token without the claim, and the proxy reuses
  a cached token until `TOKEN_REFRESH_SKEW_SECONDS` (30 s) before it expires, at most `DEFAULT_TOKEN_TTL_SECONDS`
  (300 s) after it was minted, so upgrade an application to a framework version that requires the claim only once
  300 s have passed since IAM's upgrade; earlier, its people get 401 until their cached token is replaced. **Rollback:**
  never roll IAM back to a version without the claim while an application that requires it runs; roll those
  applications back first, and IAM after them.
- **Delegation grants.** For an endpoint whose action is a dimension's `members.manage`, or that
  creates a value of a dimension, the proxy obtains a single-use grant bound to the endpoint and the
  request. IAM requires it for scope creation, assignment and revocation, so a handler on another
  endpoint cannot spend the caller's authority. The proxy obtains a fresh grant for every such
  request, also when the token cache is warm. IAM issues a grant only for an endpoint the
  application's schema lists under `delegations`, to a user principal, and consumes it like a handoff
  code: once, before its binding to the caller, the endpoint and the request id is compared.
- **Who assigns a membership role.** IAM lets a user assign or revoke a membership role in a value only when it holds
  the dimension's `members.manage` there, every action of that role there, and a role that the role's `assignableBy`
  names. `assignableBy` names membership roles of the same dimension, held in that value, or application-wide roles
  (roles with no `member`), held in that value or globally. So a staff member with a global role invites into any
  value. IAM checks the inviter again when an invitation is accepted, and the write that consumes it requires what
  that check relied on: the inviter still enabled, still holding the assigning role, the application's schema at
  the revision the check read, and the inviter's grants at the revision the check read (every removal of a grant
  moves the principal's revision on, in its own transaction), so a reconcile, a disable or the removal of any grant of
  the inviter between the check and the write makes it write nothing.
- **The application's own people.** An application whose roles are global grants declares `members: { manage, list }`
  in its vocabulary, reconciled into `app_members`. Its people are every principal holding one of its roles, globally
  or in a value. A user holding `manage` globally at the application grants and revokes the application's global roles
  through IAM's administration API (`appPeople.*` of `/admin/rpc`, reached through the console's gateway) without being
  an installation administrator: only roles the application declares with no `member`, never a built-in or a custom
  policy, only a role whose every action that user holds globally there, and only to a person IAM already has (by
  address; inviting a person stays an IAM administrator's). Each change writes its `audit_events` row under the
  application, in the change's own transaction, and writes only under the authority its check read: the user still
  enabled, the user's grant revision and the application's schema revision unchanged, so a reconcile or the removal of
  any grant of the user between the check and the write makes it write nothing. Only a signed-in session administers
  this way, never a `px_` key, presented directly or exchanged by the proxy for a console token (that token has no
  `session` mark), because a key's own grants narrow what it carries. The same holds for every administration of IAM
  through the console's gateway, an installation administrator's included: IAM refuses a console token without the
  `session` mark before it resolves any permission, and so does device approval (ADR-0042), which measures the approver's
  live permissions. A key administers IAM only presented directly, bound to IAM. A user holding `list` globally reads the directory (`listAppMembers`, `ctx.members.list()`
  of an `app: true` endpoint of that action), paged by principal id, at most 100 a page: labels where the vocabulary
  declares `directory: 'labels'` or to `manage`, addresses and last sign-ins only to `manage`. This is authorization of
  IAM's own operations, never a second enforcement decision; the alternative, one organisation value per
  single-tenant application, made every endpoint carry a scope with one value.
- **A member's last sign-in is personal data.** IAM records a person's last sign-in to each application when the
  application's proxy redeems the handoff code (`app_sign_ins`), and answers it as `lastSignInAt` beside the address,
  to a holder of `members.manage` only: the dimension's for a value's directory, the application's for its own.
- **A membership write may lead to an external principal.** An invitation by e-mail to a role declared `external`
  ([ADR-0051](0051-external-principals.md)) for a mailbox no principal holds creates the external principal when its
  owner accepts, with the password chosen there ([ADR-0020](0020-compose-human-authentication-methods.md)), in the
  transaction that consumes the invitation and writes the grant, under the same inviter re-check. Sending it creates
  nothing. IAM refuses such an invitation for a mailbox the organization names (`internal_mailbox`). The invitation
  carries a company label and a personal message as plain text, and a resend rotates its link and restarts its 7 days;
  each is one membership write under the same delegation.
- **Exact actions on every write path.** For a contract application, IAM refuses a wildcard action on
  every write path. In every IAM schema, an installation service's included, IAM refuses a
  global grant of a role declared with `member.scope`, and such a grant resolves to no permission.
- **Eligible grants.** An external principal ([ADR-0051](0051-external-principals.md)) holds only grants of a
  role its application declares `external`, a membership role. IAM refuses every other grant for it on every write
  path, in the statement that writes; refuses a reconcile that declares a role not external while an external holds
  it; and resolves such a grant to no permission. Neither a cross-app grant nor the bootstrap `admin` reaches an
  external principal, at any audience, and it issues only a key bound to itself.
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
issues that key from the approved snapshot while the contract has an endpoint with a delegation, an endpoint on, in or
below a dimension with members (its read-only member directory, `ctx.members.get` and `list`), an `app` endpoint of
the application's own `members.list`, or a share-link mount,
rotates it like a workload key, and writes it with IAM's origin as `FABRIKA_IAM_RPC_KEY` and `FABRIKA_IAM_RPC_URL`;
a reconcile that leaves the application neither deletes it. The key pins the application id: a call for another
application or environment is refused. It adds no authority, because every operation still acts as the caller's token,
and scope creation and membership changes spend the proxy's grant; issuing and revoking a share link needs none, as
on Cloudflare. It is no principal kind and no `px_` credential IAM resolves, so it mints
nothing. The surface serves no `requestDelegation`: only the proxy obtains a grant. Work unit F3 built this.

## Consequences

- **Unreachability is structural**, and one implementation of the security-critical path serves both
  providers. A fix lands once.
- **A narrower endpoint really narrows.** The proxy decides from the one selected endpoint, so an
  absent credential never reaches a broader rule.
- **The proxy decides from one shape.** Every manifest entry is an endpoint table, and the strict parser
  refuses any other form, so a manifest cannot carry a rule the decision does not read.
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
  because the manifest is read once at build, from the data file of the proxy's build archive
  ([ADR-0045](0045-upload-immutable-platform-and-namespace-proxy-sources.md)). On Cloudflare it is a proxy Worker
  deploy: the manifest is baked into the Worker's bundle through wrangler `define` (`PROXY_MANIFEST_DEFINE`), because a
  Worker variable holds at most 5,120 bytes.
- **The proxy is a per-deployment single point of failure** and the only thing that establishes an app
  session. Keep it thin. If the auth service dies, Caddy answers 502 and every request is denied.
- **Zerops carries a second toolchain** (generated Caddy JSON, a pinned binary, an Alpine runtime) and
  one loopback `forward_auth` hop per request.
- **`/__fabrika/auth/callback` is reserved on every app host.** An app route there never runs.
- **An application is closed to other origins unless both its contract and its environment open it.** A contract
  change alone opens nothing until an operator lists an origin, and an operator listing an origin opens no endpoint
  the approved contract did not mark. A changed list is a proxy rebuild on Zerops and a proxy Worker deploy on
  Cloudflare, like a changed domain. **Rollout:** nothing converges on upgrade, because nothing needs to: a contract
  without the flag keeps every digest byte for byte, `crossOrigins` is absent from every manifest until an operator
  sets one, and Control's new column starts empty, so an upgraded installation answers exactly as before. One
  operator step remains on Zerops: `upgrade` does not move a namespace's proxy source pin, and a proxy built from a
  pin older than 0.5.3, which added both fields, refuses a manifest with either. Before an application of such a
  namespace declares `admission.origins` or its environment lists an origin, the operator re-pins that namespace
  (`namespaces update --proxy-source=current`). Control cannot refuse this deploy: it does not record the pin's
  release, and the 0.5 proxy of the window reads the field.
- **A new row form needs a proxy that reads it.** A `public` row, a `capabilities` requirement, a file-response
  profile, a `cache` field and a webhook's `authorization: 'forward'` are each refused by an older proxy's strict parser, so a manifest that holds one never
  reaches a proxy that would serve it without its rule. **Rollout:** a contract without them keeps every digest byte
  for byte. On Cloudflare the runner deploys the proxy Worker with the application. On Zerops Control refuses, before
  any effect, a deploy whose contract holds a row that no older release's proxy parses, while the namespace's proxy
  source is another than the one it deploys new placements from, and names the re-pin
  (`fabrika control namespaces update --namespace=<id> --proxy-source=current`). It judges each row with the strict
  row parser of 0.4.8, 0.5.5 and 0.6.0, the newest patch of each minor before 0.7 in the window
  ([ADR-0062](0062-a-platform-release-serves-older-framework-releases.md)), so the five forms above are refused, and so
  is any later one, without a list to keep. 0.7.0's parser is not a judge: Control does not record a pin's release, and
  a form only 0.7 reads would then reach a namespace pinned to 0.4–0.6, whose parser refuses the whole manifest. A row
  one of the judges parses deploys: every row of a 0.4, 0.5 or 0.6 application, and every row of a 0.7 or 0.8 one that
  uses none of the new forms.
- **The platform keeps serving the rows of older framework releases**: a 0.4/0.5/0.6 form row with its content types,
  its cross-origin form and its multipart origin check, a collection's `upload` and `download` rows, and a webhook's
  generated binding rows, until no framework release in the window produces them
  ([ADR-0062](0062-a-platform-release-serves-older-framework-releases.md)).
- **A cross-origin page reaches an endpoint only with a key.** A page that wants a person's own authority asks the
  person for a `user` key; the session never crosses origins.
- **The proxy's public scheme comes from the manifest** (absent means `https`); behind a TLS-terminating
  balancer no header can supply it.
- **The proxy refuses to boot without `FABRIKA_IAM_ISSUER` and `FABRIKA_IAM_KEY`**, rather than boot
  and answer 503 to everything.
- **IAM attributes a request on Zerops only when the proxy proves it sent it.** A caller on the private network
  cannot rotate its client bucket or forge a correlation id. The console's admin hop through Control carries no
  secret, so an admin action's audit row gets a generated id instead of the proxy's. **Rollout:** no generated
  file changes and no provider state is added. The first `platform upgrade` writes the derived variable to `proxy`
  and `iam` before any build; nothing is removed or renamed. IAM deploys before the proxy, so for those minutes the
  old proxy sends no secret and every request falls into the shared bucket with a generated id. That bucket
  refuses once exhausted, exactly as the balancer's address does today, because Zerops installations configure no
  trusted balancer range; if the proxy build fails, the state lasts until the next successful deploy. Once the proxy
  is deployed the headers count again. A rollback of IAM ignores the variable.
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
  is the product. The second multiplies deployables, caches and table copies for the same guarantee.
- **Let the proxy ask the app for its table.** Makes the protected component authoritative over its own
  protection. The same reason keeps the endpoint table out of anything the running application reports:
  Control reads it from the commit ([ADR-0050](0050-approved-access.md)).
- **A Go plugin in Caddy.** A second implementation of the authorization check, bound to diverge from
  the Cloudflare one.
- **Traefik, nginx `auth_request`, or a TypeScript proxy on both platforms.** Traefik plugins run
  interpreted and its discovery is irrelevant here; `auth_request` cannot return the login redirect
  without extra machinery; our own proxy puts WebSocket, streaming and HTTP/2 correctness on us.
- **Compile endpoint tables into Caddy routes.** Rejected: a matcher cannot read the credential, the
  caller kind or the requirement, and Caddy's case-insensitive, `//`-merging path matcher would select
  for a slightly different set of paths, in the permissive direction.
- **Put the installation services on application contracts** (`defineContract` and `implement`).
  Rejected: `boot` deletes the framework variables and binds `@fabrika/db`, and the services would need
  more exceptions than the five installation forms. An installation entry reuses the endpoint table and
  the matcher instead.
- **Let the application select the endpoint again from the path.** Rejected: two selections can
  diverge. The application serves the id the proxy selected; its own selection only has to agree.
- **One digest for the whole contract instead of one per endpoint.** Rejected: every endpoint would
  answer 503 during a switch, not only the changed ones.
- **Rely on the private network alone for the hop.** Rejected: every service in a Zerops namespace
  shares that network, so a sibling service could dial the application directly.
- **A proxy secret from the Cloudflare proxy Worker too.** Rejected: the service binding already authenticates that
  hop, and the application Worker has no public route. The secret travels only on the application Worker's hop to its
  Durable Object, whose class another Worker on the account can bind.
- **Let cross-application grants enter every application token.** Rejected: a token minted for one
  application would carry authority over others, and the requirement check would pass on a grant the
  application never declared.
- **One IAM application per application, shared by its environments.** Rejected: a staging key or role
  would also work at production.
- **Name the allowed origins in `fabrika.config.ts`.** Rejected: the access surface a proxy publishes comes from
  the approved snapshot and Control's records ([ADR-0050](0050-approved-access.md)), never from a file the
  repository's code can change unreviewed.
- **Name the allowed origins in the contract, by environment name.** Rejected: the contract would have to know the
  installation's environment names, and moving a partner's page to a new host would be a new approval of the
  application rather than an operator's change.
- **Let an environment list `*`.** Rejected: one entry would open every cross-origin form and, if honoured there,
  every credentialed endpoint. A public procedure meant for any site says so in its contract (`origins: 'any'`), where
  it is approved.
- **Send `Access-Control-Allow-Credentials` and let a session cross origins.** Rejected: any listed page could then
  act as the signed-in person without the person's knowledge, which is what the `cross_site` rule exists to stop.
- **Let the application answer the preflight, or Caddy from its configuration.** Rejected: the first is a second
  enforcement decision inside the process an agent edits, the second compiles part of the table into a matcher,
  which this ADR rejects for the reasons in its Context.
- **A shared parent-domain session cookie, or every app on one hostname.** The first fails on
  `*.zerops.app` and forces apps under a platform domain. The second breaks routing by `Host` and loses
  cookie and CORS isolation between apps.
- **Promise that a user's `label` is its address.** Rejected: `label` is the spelling, not the normalized mailbox, and
  every writer of a label would carry the promise. The `email` claim is the column IAM matches identities by.
- **Ask IAM who the page's person is.** Rejected: the token already states the label, the mailbox and the grants, and
  an IAM call per page load would be a second source that disagrees with the token for up to its lifetime.
- **Answer `{ signedIn: false }` to an anonymous caller of the caller document.** Rejected: a public page arrives
  without a token whether its visitor is signed in or not, so the answer would claim what the application cannot know.
- **A separate Cloudflare entrypoint for redemption.** Real churn for little gain; the code's own
  properties stop replay.
