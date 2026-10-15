# What fabrika-platform is

fabrika-platform is a **single-tenant application platform** with three product
planes for applications that run entirely on **one** cloud platform:

- **Delivery** declares, provisions, and deploys applications.
- **Access** owns identity, policy, and audit.
- **Operations** ingests and groups errors, correlates releases and source maps,
  supports triage, and monitors active health.

Delivery and Access came from two previously separate, Cloudflare-only projects
([ADR-0011](../decisions/0011-static-provider-bundles.md)); Operations absorbed
the first useful Poplach slice under
[ADR-0016](../decisions/0016-independent-operations-plane.md):

- **propustka** — IAM & audit: OIDC SSO, opaque `px_` API keys, AWS-IAM-style
  policies over app-owned scope dimensions, an audit log.
- **vozka** — deploy control plane: an app declares its cloud resources, its
  authorization schema and its build pipeline in one config file; a control-plane
  Worker hands each deploy to a Cloudflare Container that clones the repo and runs
  the deploy engine.

## Why it exists in this shape

Both ancestors assumed Cloudflare everywhere. Some clients want to run entirely
**off** Cloudflare — specifically on [zerops.io](https://zerops.io). That is the
whole driver for the merge and for every portability decision in
[`../decisions/`](../decisions/README.md).

Three constraints follow from it, and they are load-bearing:

1. **A client picks ONE platform for everything.** Control, IAM, Operations, and
   apps all run on the same platform. There is no cross-platform deployment.
2. **Deployments are single-tenant.** One client, one installation.
3. **App portability is explicitly out of scope.** An individual app targets one
   platform and may use that platform's primitives freely. It is _fabrika itself_
   that must be portable, not the apps it deploys.

Consequence worth internalising: "multi-cloud" here means _fabrika runs on either
platform_, never _an app runs on both_.

## The services an installation runs

The three planes say what the platform does. They are not the list of services an
installation stands up, and that list differs per provider.

A **Zerops** installation runs four platform services. `fabrika platform deploy`
owns their order — `iam` and `operations` first, then `proxy`, then `control` —
so the enforcement point is always ahead of the service whose table just widened
([ADR-0027](../decisions/0027-platform-deploy-is-as-wide-as-the-provider-needs.md)):

| Service      | What it is                                                                   |
| ------------ | ---------------------------------------------------------------------------- |
| `iam`        | the Access plane                                                             |
| `operations` | the Operations plane                                                         |
| `proxy`      | the enforcement point, one per deployment namespace                          |
| `control`    | the Delivery plane, the origin that serves the console, and the source fetch |

A **Cloudflare** installation has no standalone proxy service. IAM and Operations
each deploy as their own platform config, and the deploy executor and control
deploy as a pair. The proxy is materialized per app environment instead: a public
proxy Worker in front of a private application Worker.

On Zerops, control itself delivers application sources, because Zerops builds
from an archive it is handed and its native GitHub integration cannot be driven
by an installation's project-scoped token
([ADR-0029](../decisions/0029-github-app-sources.md)). Control resolves the
requested ref to an exact commit and to the SHA-256 of the repository-root
`zerops.yaml`, then streams GitHub's `git archive` tarball to the presigned Zerops
upload URL — `gunzip → tar rewrite → gzip → PUT`, with no repository byte staged
on disk. The rewrite keeps regular files only and refuses symlinks, `.gitmodules`,
and trees above 50,000 entries or 512 MiB. Public platform uploads explicitly
enable validated relative symlinks and check Git tree metadata to reject
submodules even without their marker. Control never executes repository code.
The code lives in `packages/control/src/github/source/`.

Private repositories are read through operator-owned GitHub Apps — one App per
GitHub organization, created and verified from the authenticated console
([ADR-0029](../decisions/0029-github-app-sources.md)). On both clouds, every
connection's App id and private key live in control's vault next to that
connection's webhook secret. `@fabrika/github-app` is the shared client: the least-authority manifest
builder, the bounded manifest-code exchange, installation-token minting, and
webhook configuration. A public repository is fetched anonymously and needs no
App at all.

## The packages

| Package                        | What it is                                                                                    |
| ------------------------------ | --------------------------------------------------------------------------------------------- |
| `@fabrika/auth-core`           | Shared authz kernel: policy model, contract artifact, endpoint matcher, token, RPC.           |
| `@fabrika/auth`                | The published app-facing SDK. Verifies the proxy-injected token; enforces nothing.            |
| `@fabrika/jwks`                | The one JWKS-backed token verifier the SDK and the proxy both wrap (ADR-0040).                |
| `@fabrika/app`                 | Contract kit and runtime (`serve`), service dispatcher, typed RPC, client, runtime adapters.  |
| `@fabrika/iam`                 | The IAM service itself: human authentication, identity, keys, policies, and audit.            |
| `@fabrika/iam-contract`        | Runtime-neutral IAM admin REST DTOs and typed RPC contract.                                   |
| `@fabrika/email`               | Portable outbound email contract and fetch-based provider adapters.                           |
| `@fabrika/operations-contract` | Runtime-neutral ingest, catalog, release, access, operator DTOs, and typed RPC contract.      |
| `@fabrika/operations`          | Error ingest, grouping, triage, releases, source maps, health, and runtime compositions.      |
| `@fabrika/provider-contract`   | Control-provider contract, shared `runSteps`, envelopes; `/installation` command contract.    |
| `@fabrika/provider-cloudflare` | Cloudflare authoring, deploy, control adapter; `/runner` job contract; `/installation`.       |
| `@fabrika/provider-zerops`     | Zerops authoring, manifest compiler, API client, deploy, control adapter; `/installation`.    |
| `@fabrika/platform`            | Runtime ports shared by control, IAM, and Operations.                                         |
| `@fabrika/platform-node`       | Bun/Postgres/S3 implementations of those runtime ports.                                       |
| `@fabrika/control`             | Shared control-plane core plus separate Cloudflare Worker and Zerops/Bun composition roots.   |
| `@fabrika/control-contract`    | Runtime-neutral control DTOs, typed RPC contract, and deploy log line shape.                  |
| `@fabrika/platform-artifacts`  | Private Zerops installation codegen: generated `zerops.yaml`, import YAMLs, and schemas.      |
| `@fabrika/installation-init`   | The operator-side `init` mechanics both installations share.                                  |
| `@fabrika/builder`             | Guided specification, review, and agent-assisted implementation loop.                         |
| `@fabrika/cli`                 | The single public `fabrika` command and provider-aware command router.                        |
| `@fabrika/check`               | The application checker (`fabrika-check`) and the static contract reader (`/contract`).       |
| `@fabrika/dashboard`           | Unified Delivery, Access, and Operations console served by control.                           |
| `@fabrika/runner-container`    | Plain-Bun process and container image that execute Cloudflare runner jobs.                    |
| `@fabrika/runner-cloudflare`   | Out-of-band Cloudflare Worker that hosts and relays the deploy container.                     |
| `@fabrika/github-app`          | Published GitHub App client: manifest builder and exchange, installation tokens, webhooks.    |
| `@fabrika/proxy-core`          | The runtime-neutral enforcement decision; `/manifest` is the wire contract and strict parser. |
| `@fabrika/proxy`               | The Caddy deployment of that decision: generated config, Bun process, and binary.             |
| `@fabrika/local-stack`         | The Docker development stack behind every `local:*` command.                                  |

`@fabrika/auth` is the published application-facing IAM SDK; the rename from the
predecessor packages was a deliberate, one-time break — see
[ADR-0011](../decisions/0011-static-provider-bundles.md).

The narrow contract packages keep wire types away from runtime entrypoints:

- `@fabrika/control` and `@fabrika/dashboard` share RPC DTOs through
  `@fabrika/control-contract`; its `RunLogLine` also crosses the runner boundary.
- `@fabrika/iam` and `@fabrika/dashboard` share admin REST DTOs through
  `@fabrika/iam-contract`. The `IamRpc` and policy domain stay in
  `@fabrika/auth-core`.
- `@fabrika/operations`, `@fabrika/dashboard`, and control's transport-only
  gateway share DTOs through `@fabrika/operations-contract`.
- the Zerops provider and control composition produce
  manifests through `@fabrika/proxy-core/manifest`; `@fabrika/proxy-core` parses and
  evaluates them, and `@fabrika/proxy` is the Caddy deployment that runs it.
- `@fabrika/runner-cloudflare` and `@fabrika/runner-container` communicate
  through `@fabrika/provider-cloudflare/runner`, which also holds the runner job
  semantics.
- `@fabrika/cli` loads `@fabrika/provider-<cloud>/installation` through the open
  contract in `@fabrika/provider-contract/installation` and exposes the guided
  builder through `@fabrika/builder` under `fabrika builder …`. The builder and
  both providers are its optional peers: an application installs only its own
  provider, and a command whose package is absent names the package to add.

## Operator console

Control serves one Fabrika console with Delivery, Access, and Operations
navigation. Delivery uses `ControlRpcContract` at `/api/rpc`. Access routes
use `IamAdminRpcContract` at `/iam/admin/rpc` on the same control origin.
Operations routes use `OperationsRpcContract` at `/operations/api/rpc`. Control transports the
latter two requests to the corresponding private service. IAM and Operations
retain authentication, authorization, domain-data, and audit ownership.
Cross-origin mutations are rejected at both gateways. The IAM gateway drops the
console's cookies and forwards the proxy-injected token as a bearer: IAM's
`/admin/*` is bearer-only and accepts that token or a `px_` key, never a session
cookie.

IAM has no standalone SPA or public admin origin. Its public HTTP surface is
limited to native authentication and JWKS endpoints. Control-to-IAM RPC and admin
traffic use the platform's private service binding or network.

Operations also has no standalone SPA or public operator origin. Its public
hostname accepts only source-bound Sentry envelope ingest and authenticated,
bounded source-map upload. Catalog and release synchronization, operator API
requests, health, and IAM principal lookup stay on the private platform network.
An Operations outage does not roll back registry mutations or deploys; control
records desired projections and replays them during maintenance.

The console's IAM application keeps the durable id `vozka` and is named
`Console` for people. Its schema (`packages/control/fabrika.schema.ts`) presets
five roles, each grantable globally or at one app or environment: `observer`
(`operations.read`), `triager` (`operations.read`, `operations.triage`),
`deployer` (`deploy.*`), `operator` (`deploy.*`, `operations.*`) and `admin`
(`*`). Registry, namespace, secret, source-connection and approval actions
belong to no preset but `admin`. The console asks Control's `consoleAccess`
which of these actions the caller holds, and IAM whether the caller
administers IAM or an application's people. It shows only the pages the caller
may use, and a caller who may use none sees that no role is granted yet. This
is presentation: every procedure keeps its own authorization.

Each registered application environment may carry an explicit canonical
`publicOrigin`. It is independent of the provider routing domain and is the only
origin Operations uses for active HTTP health checks. Control does not infer it
from provider envelopes or DNS names.

## Application runtime

`@fabrika/app` is the server framework for Fabrika applications. An application
declares `fabrika.contract.ts` with the staged kit, its handlers beside their endpoints, and serves it through
`serve` (`@fabrika/app/implement`). The package root holds the typed RPC library, the
structural error responses, the typed browser RPC client, and the `FetchService`
type that the runtime adapters serve.

The package root is runtime-neutral. Cloudflare and Bun lifecycle APIs live under
`@fabrika/app/cloudflare` and `@fabrika/app/bun`.

The platform's own IAM, Delivery, and Operations services do not use a contract.
Each declares a service contract (`defineServiceContract` in
`@fabrika/app/service`) and serves it with `serveService`, a runtime-neutral
`FetchService`; Cloudflare/Bun lifecycle code stays in its composition root. Delivery and Operations authenticate through the IAM SDK;
IAM owns the identity boundary behind it. Control and Operations expose typed
RPC administration alongside protocol-specific HTTP and service bindings.
The three concrete compositions, protocol surfaces, and shared Postgres
migration wiring are documented in
[`core-application-composition.md`](core-application-composition.md).

The proxy and the application perform different checks. The proxy decides from
the endpoint table before a request reaches the private app service. An
application writes no authentication code: `serve` serves its contract, and
the generated entrypoint's `boot` verifies the injected token and checks the
caller kind, the requirement, admission and the access form of each endpoint. Control
and Operations call `iam.authenticate(request)` in their row handlers, which
verifies the injected Fabrika token and provides the canonical `@fabrika/auth`
`AuthContext`. An RPC procedure's `.require(action, scope)` then checks the
application-owned object coordinate that an endpoint row cannot know. See
[`application-runtime.md`](application-runtime.md) and
[ADR-0012](../decisions/0012-fabrika-app-runtime.md) and
[ADR-0013](../decisions/0013-explicit-runtime-adapter-entrypoints.md).

## Provider composition

One installation has exactly one provider. The Cloudflare Worker entrypoint
statically imports `@fabrika/provider-cloudflare`; the Zerops Bun entrypoint
statically imports `@fabrika/provider-zerops`. Shared control code does not
contain a provider registry, a provider-id union, or branches for either
provider ([ADR-0011](../decisions/0011-static-provider-bundles.md)).

App configs use the selected provider package as their authoring surface:

- Cloudflare configs import `defineApp` and Oblaka resources from
  `@fabrika/provider-cloudflare`. `fabrika app deploy` executes an app deployment.
- Zerops configs import `defineApp` and Zerops resource types from
  `@fabrika/provider-zerops`. `fabrika app build` evaluates the config and
  writes the static `fabrika.manifest.json` consumed during registration.

The public CLI infers the app provider from the object returned by the selected
provider's `defineApp()`. App commands therefore need `--provider` only when the
config is absent. Platform commands load one `@fabrika/provider-<cloud>/installation`
module through `@fabrika/provider-contract/installation`; official provider names
are aliases, and a package specifier can supply another installation module.

The control-plane registry persists provider-owned target and artifact data as
opaque `{ provider, version, payload }` JSON envelopes. The selected provider
validates and normalizes those envelopes. Shared control owns registry rows,
locks, run status, secret resolution, and queue semantics; the provider owns
deploy, cancellation, reconciliation, and optional provider-managed secret
operations. Providers may also own deployment namespaces: placement lifecycle,
resource claims, and operator plans behind the same static contract. Adding
another statically linked provider does not require a core schema column or a
core provider branch.

Runtime portability is separate from deployment-cloud semantics.
`@fabrika/platform` defines SQL, blob, queue, lock, asset, and lifecycle ports.
The installation composition root binds those runtime ports and its provider
bundle together. See [`provider-bundles.md`](provider-bundles.md) for the
boundary in detail.

## How a deploy works

The control plane accepts a deploy request, takes the per-app-environment lease
(90 s TTL, renewed every 30 s; `packages/control/src/lease.ts`),
resolves the source-scoped Operations ingest configuration, and calls the
statically selected `ControlProvider`. It supplies managed
`FABRIKA_OPERATIONS_DSN` and `FABRIKA_RELEASE` values separately from app-authored
configuration; providers reject collisions with those reserved names. The
provider's `deploy()` runs its own ordered steps through the shared `runSteps`
helper in `@fabrika/provider-contract`; control never sees provider target data,
artifact data, or step kinds.

Right after the provider pins the run's commit, Control reads the run's **access snapshot** at that commit
([ADR-0050](../decisions/0050-approved-access.md), `packages/control/src/approval/`): the contract graph and
`src/db/tables.ts` through the static reader of `@fabrika/check/contract`, which executes nothing, and every
`db/migrations/` file with its SHA-256 and the database code the runner's classifier finds in it (a refused statement
fails the run). It classifies the snapshot against the environment's active snapshot (that of
`app_envs.published_run_id`). A step off the paved road — a site's declared `sql`, `unscoped`, `connect` or link
issuing, or a migration's database code — is a widening line marked "needs closer review", not a refusal; the
console's environment page lists the published snapshot's. A widening on an environment with `protected` set (`prod` by
default) parks the run in `awaiting_approval`; it publishes nothing until a person approves it in the
console. Otherwise the run publishes its snapshot with a compare-and-swap on `app_envs.generation` and
`protection_revision`, under the namespace lease. Every provider environment and namespace member then carries
`approvedSnapshot`'s access, and the providers publish a contract application's endpoint table and reconcile
its IAM schema from it, never from the artifact. A commit without `fabrika.contract.ts` fails its run before the
provider is called: Fabrika deploys an application only with a contract. Approving needs `access.approve` (authorization) from a human user principal on a
console request from Control's own origin (admission).

For non-dry Cloudflare deployments, Control verifies the recorded GitHub commit or resolves a concrete
ref, then persists the selected commit before freezing its release context.
`@fabrika/runner-cloudflare` starts a Cloudflare Container and POSTs the job. The
`@fabrika/runner-container` process fetches the exact commit, detaches HEAD and
compares it before installing dependencies or invoking the internal
`fabrika-cloudflare-executor`. Unavailable or mismatched source fails before
repository commands; there is no mutable-ref fallback. The run commit, checkout,
runtime release and source-map scope identify the same source
([ADR-0048](../decisions/0048-bind-cloudflare-delivery-to-the-recorded-commit.md)).
`@fabrika/provider-cloudflare/runner` is the boundary between Worker and image.
Keeping the runner Worker separate lets the control plane deploy itself without
resetting the container that owns the run.

The Cloudflare runner also owns the build filesystem, so it can upload bounded
source maps to the release-scoped Operations artifact endpoint. Zerops builds
inside its own platform and does not yet publish those artifacts; that remaining
gap is [backlog 36](../backlog/36-complete-zerops-release-artifact-correlation.md).

On Zerops, the app build runs `fabrika app build --env=<env>` and produces a
versioned `fabrika.manifest.json`. Registration stores manifest version 2 in the
Zerops artifact envelope version 2. Its structured import document is the source
for both service claims and the YAML sent to Zerops. The app target envelope
version 2 stores only the app service id; the assigned deployment namespace
supplies the Zerops project and proxy coordinates. A queued deploy never imports
app TypeScript: the Bun control process applies the compiled import, triggers the
service pipeline, polls its app-version, and reconciles the IAM schema.

Control delivers the repository itself. Before the Operations release context
exists, control resolves the requested ref and fails the run when the
`zerops.yaml` digest at the resolved commit differs from the registered artifact.
The deploy then runs `apply-import → verify-exposure → write-service-env →
reserve-version → upload-source → trigger-build → await-version → reconcile-schema`
(`packages/provider-zerops/src/plan.ts`). `reconcile-schema` runs only when the
app declares a schema. `verify-exposure` refuses the run, and raises an
Operations alert, when a declared service has subdomain access or a bucket
lacks the platform's provenance
([ADR-0043](../decisions/0043-validate-and-render-one-zerops-descriptor-meaning.md)). Control streams the archive to the reserved version's
presigned upload URL; the Zerops token never leaves control
([ADR-0029](../decisions/0029-github-app-sources.md)).

Only `FABRIKA_RELEASE` is bound to the version: `trigger-build` writes it into the
execution descriptor's `run.envVariables`. For a contract application `trigger-build`
sends a generated setup instead, which also carries `FABRIKA_CONTRACT_DIGEST`. The other managed keys
(`FABRIKA_OPERATIONS_DSN`, `FABRIKA_IAM_ISSUER`, `FABRIKA_IAM_APP_ID`, `FABRIKA_APP_ID`,
`FABRIKA_ENVIRONMENT`, `FABRIKA_SERVICE_KEY`) are plain service variables that
`write-service-env` overwrites
([ADR-0044](../decisions/0044-zerops-delivery-ownership-and-recovery.md)).

The run checkpoint is `{ appVersionId, triggered }`, recorded before upload and
again before the build request. Recovery never resumes: an untriggered version
is deleted and the run fails; a triggered one is polled to a terminal state.
Startup and scheduled maintenance call the provider reconciliation capability for
unfinished platform-owned runs, so a self-deploy or restart does not lose the
terminal state or terminal Operations release projection
([ADR-0003](../decisions/0003-no-deploy-runner-on-zerops.md),
[ADR-0044](../decisions/0044-zerops-delivery-ownership-and-recovery.md)). A
release is unique per source and immutable commit, while every deploy attempt
keeps its own run link. The release summary follows the latest `observedAt`, so a
delayed failure from an older attempt cannot replace a newer successful retry.

Secret edits follow the same registered service address but are not a deploy step.
The control plane writes or deletes them immediately through the service-env API
and stores only a `zerops:` reference. It never writes an app secret at project
scope.

## How auth works

Three kinds of check refuse a request, and only the first is what ADR-0022 calls
enforcement:

- **Enforcement** — the proxy's decision whether a request reaches a private
  service at all. Every manifest entry is an endpoint table, in one of two forms. A
  contract application is protected by its application table; an installation
  service by its installation entry. There is exactly one enforcement decision, in
  `@fabrika/proxy-core` over `@fabrika/auth-core`'s `planEndpoint`, and the proxy is
  the only thing that runs it. The proxy selects one endpoint and checks its caller
  kind, its requirement and admission there, with no fall-through to another
  endpoint, then names the endpoint and the digest of those rules in
  `X-Fabrika-Endpoint`. An installation entry is an endpoint table that platform
  composition marks `installation: true`; it may use five forms no application may
  declare (`protocol` and `service` rows, the method `*`, the caller `oauth`, the
  requirement `authenticated`), and its hop keeps `Authorization`, sets no proxy
  secret and leaves the service's answers untouched. The console, Operations and IAM
  are each fronted by theirs. Each service's table is a service contract
  (`@fabrika/app/service`). `packages/proxy-core/src/__tests__/installation-matrix.test.ts`
  proves that the real installation tables refuse what no service may receive. The
  console's table has an MCP variant; Control reads which one its proxy publishes
  from `FABRIKA_SERVICE_TABLE_DIGEST` and refuses to start under any other.
- **Authorization** — the action-and-scope check a service makes against an
  application-owned object coordinate. An endpoint row cannot make it, because the
  coordinate is known only once request data is validated. Every
  `.require(action, scope)`, every `can()` call, control's per-route
  `authorize`, and a contract application's caller-kind, requirement and access-form
  checks (`boot`, ADR-0012) are this layer.
- **Admission** — the confused-deputy guards in front of ambient credentials: the
  proxy's `Sec-Fetch-Site` check on a session's request that is not a `GET`, and its
  `Content-Type` check, on every endpoint table — the console's three JSON mounts and
  a contract application's endpoints alike. They decide whether a cookie-bearing
  request is considered at all; a bearer is explicit authority and passes without
  them. Control reads no `Origin`, and IAM's own admin surface reads no cookie — it
  accepts only a bearer. They resolve no principal and read no policy, so none of
  them is a second enforcement decision.

The enforcement decision never replaces an authorization check, an authorization
check never replaces it, and an admission check substitutes for neither.

The **proxy is the only enforcement point**, on both providers
([ADR-0022](../decisions/0022-the-proxy-is-the-only-enforcement-point.md)). Only the
proxy is publicly routed; app services stay internal, so bypassing auth stops being
possible rather than merely discouraged. It is Caddy plus a loopback-bound Bun auth
service on Zerops, and a thin Worker calling the same code in-process on Cloudflare.
Caddy owns HTTP correctness and gets no vote on authorization: its configuration is a
fixed three-step chain per app — delete every `X-Fabrika-*` hop header (`FABRIKA_HOP_HEADERS` in `@fabrika/auth-core`:
token, client address, endpoint, delegation grant, proxy secret), the request id and the forwarding headers;
`forward_auth`; proxy to the private upstream, with a contract app's proxy secret set and its answer given the
response header policy (the file treatment for a download) — and endpoint rows are never compiled into
route matchers. Endpoint tables are decided once, in TypeScript, against the
manifest. Before any endpoint is selected, the proxy refuses a non-canonical raw path with 400 and a request without a
forwarded method; a contract application's `boot` and `serveService` refuse the same paths.

Nothing downstream of the proxy enforces. An application reads the proxy-injected
`X-Fabrika-Token`, verifies it locally against IAM's JWKS, and builds its
`AuthContext`. A contract application also serves only the endpoint
`X-Fabrika-Endpoint` names, with the digest of its own rules, and answers 503
otherwise. On Zerops it first refuses, with 403, a request without its proxy secret
(`X-Fabrika-Proxy-Secret`), because a sibling service in the namespace can dial it
directly; on Cloudflare the service binding is the authenticated hop; `@fabrika/auth` cannot make an enforcement decision, exchange a session, or write a
cookie.

A browser that authenticated at IAM reaches an app through a one-time code the proxy
redeems at a reserved callback path, whether or not the two share a domain. A browser-held
verifier binds that callback to the app host that started login. No cookie is ever shared
between two hosts, each host's session cookie carries the `__Host-` prefix, and the proxy
removes every Fabrika cookie before the application while preserving app-owned cookies
([ADR-0023](../decisions/0023-one-session-per-host.md),
[ADR-0023](../decisions/0023-one-session-per-host.md)). See
[`cross-host-sso.md`](cross-host-sso.md).

The IAM service stays **global** — one identity database, one audit log, one admin
UI. The proxy is stateless and horizontally scalable. Zerops owns one proxy per
deployment namespace; the current Cloudflare app graph owns one proxy root per
app environment. Cloudflare application children have no routes and disable
`workers.dev`. For correlation, the proxy preserves or creates `X-Request-Id`
and copies it onto the allowed upstream request. IAM does not choose which header
it trusts for its audit records: each composition root names the one its ingress
overwrites. The Worker names `cf-ray`, because it is edge-routed and no proxy
strips a caller's `X-Request-Id` in front of it. The Bun process names the proxy's
`X-Request-Id`. An accepted value is at most 64 characters from `[A-Za-z0-9._:-]`.
IAM replaces any other value with a generated UUID and does not truncate it. The
same rule applies to the `requestId` that apps pass to `IamRpc`.

On Zerops the proxy manifest is a baked deploy artefact. Before an app deploy, the
control plane compiles every registered app manifest assigned to that namespace,
writes the JSON to the namespace proxy's service-level
`FABRIKA_PROXY_MANIFEST_JSON` variable, and rolls the proxy. Cloudflare app
authoring embeds one app manifest in the proxy Worker's vars and binds the app
Worker under `APP`; the provider deploys the proxy and child configs together.
Missing or malformed JSON fails closed. The control plane never uses a project-level
variable for this path.

## Related reference

- [`human-authentication.md`](human-authentication.md) — OIDC and password login,
  enrollment and reset, sessions, and bootstrap behaviour.
- [`cross-host-sso.md`](cross-host-sso.md) — the session handoff: how a browser
  authenticated at IAM ends up authenticated at an app, on any host, with no shared
  cookie.
- [`deployment-namespaces.md`](deployment-namespaces.md) — placement lifecycle,
  resource claims, Zerops presets, and operator interfaces.
- [`zerops-platform.md`](zerops-platform.md) — the established facts about Zerops
  that the decisions rest on, with sources.
- [`portability-surface.md`](portability-surface.md) — every Cloudflare primitive
  currently in use and its portable counterpart, plus the IAM port assessment.
- [`provider-bundles.md`](provider-bundles.md) — the static provider contract,
  persistence boundary, and composition roots.
