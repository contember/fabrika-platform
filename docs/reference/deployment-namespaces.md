# Deployment namespaces

A deployment namespace is a provider-owned placement boundary for zero or more
application environments. It has stable provider-neutral coordinates:

```ts
interface ProviderDeploymentNamespace {
	id: string
	env: string
	exclusiveAppId?: string
	target: ProviderEnvelope
}
```

The control plane stores the namespace lifecycle separately from application
registrations. An `app_envs.namespace_id` assigns one application environment to
one namespace. The provider-specific namespace target remains an opaque,
versioned JSON envelope.

## Provider contract

`ControlProvider.namespaces` is optional. Providers that implement it supply:

- `normalize`, which validates and canonicalizes the namespace target;
- `namespaceResourceClaims`, which declares provider-owned resource keys;
- `registrationResourceClaims`, which derives app-owned keys from a normalized
  application registration;
- idempotent `provision` and `reconcile` operations;
- an optional operator surface with presets, mutation-free planning, and a
  credential-free presentation.

The operator surface accepts provider-neutral coordinates plus an opaque JSON
`options` value. A plan returns the complete namespace envelope that can be
submitted unchanged for creation, together with safe display facts and operator
instructions. A presentation may also name the public `hosts` the namespace
serves, each with the listener port that publishes it. Only the provider knows
how a host comes to exist, and only shared control knows which application
environment claims one, so the provider names them and control marks them. Shared control validates that planning and normalization preserve
the namespace id, environment, exclusive owner, and provider id.

The namespace lifecycle reports durable provider checkpoints through
`ProviderNamespaceEvents.checkpoint`. Shared control persists each checkpoint
before the provider continues to its next external mutation.

The provider mutation does not run inside the request. `create`, `adopt`, and
`reconcile` persist the row, enqueue a namespace job on the control queue, audit,
and answer `pending`; a worker then claims `pending` to `provisioning`, runs the
provider mutation with its own signal, and records `ready` or `failed`. A caller
polls the `namespaces.get` RPC procedure and may disconnect without affecting the outcome.
A namespace left `provisioning` by a crashed worker is resumed from its
checkpoints, and a job for a namespace that already settled is a no-op.
`reconcile` on a namespace that is still settling only enqueues: it never rewrites
the provider target, because a job in flight may be checkpointing it.

## Persistence and assignment

`deployment_namespaces` stores:

- id, environment, provider, and optional exclusive app id;
- the provider target envelope;
- lifecycle state: `pending`, `provisioning`, `ready`, or `failed`;
- the last bounded lifecycle error, as a stable code and a redacted message.

A failed lifecycle records both halves of what the provider reported. Providers
raise a `ProviderNamespaceError` carrying a stable `code` — a platform error code
such as `insufficientPermissions`, or a provider-defined identifier for a
lifecycle invariant — a short summary, and the upstream's own words as `detail`.
Control stores `code` and a redacted, bounded message in one column as
`<code>: <message>` and projects them as `lastErrorCode` and `lastError`. A
failure that is not a typed provider error is recorded as `internal` with a
generic message. The full cause is logged, redacted the same way: userinfo,
signed query strings, API keys, and signed tokens never reach the row or the log.
A row written before the codes existed carries a message and no code.

A failure the provider marks retryable leaves the namespace `provisioning` with
its error recorded, and every maintenance pass queues a `reconcile` for it, so
it settles on its own once the cause clears. A GitHub rate limit on the proxy
source is one (`githubRateLimited`, whose message names the reset time). A
deploy or republish that finds the namespace not `ready` is refused with its
state and last error: a `failed` one names the
`fabrika control namespaces reconcile --namespace=<id>` repair, a settling one
asks for a later deploy.

An application environment may be assigned only to a namespace with the same
provider and environment. An exclusive namespace accepts only its named app. A
new assignment requires a `ready` namespace. The assignment cannot change while
a deploy is in flight or after the environment has a successful deploy.

Registration passes the application, environment, namespace, app target, and
artifact through `normalizeRegistration`. The resulting provider coordinates are
stored together. Namespace assignment through the dashboard or API sends the
existing app target and artifact envelopes unchanged.

An application environment stores provider routing `domain` separately from its
optional `public_origin`. The latter is an explicit, canonical HTTP(S) origin
for user-facing runtime observation; control never derives it from the provider
domain. Registration omission stores `null`. Environment PUT omission preserves
the existing value, while explicit `null` clears it. Control projects the value
to Operations, where active HTTP checks use it as their origin. A missing origin
leaves active health unavailable rather than inventing an endpoint.

An environment also lists the origins whose pages may call its cross-origin
endpoints (ADR-0022 "Cross-origin endpoints"), kept in `app_envs.cross_origins_json`
beside its domain. An operator sets them with a repeated `--cross-origin=<origin>` on
`fabrika control register` and `fabrika control apps environments put`
(`crossOrigins` on the RPC). Each is an exact origin with a literal host, listed once,
never the environment's own domain, at most 16; Control refuses anything else with a
400 naming the origin, judged by `@fabrika/proxy-core/headers` `isCrossOrigin`. Unlike
`domain`, a PUT that omits the list keeps it, and an empty list (`--cross-origin=`
alone) clears it. Control hands the list to the provider (`ProviderEnvironment` and
`ProviderNamespaceMember.crossOrigins`), which writes it into the application's proxy
manifest entry as `crossOrigins`, omitted when empty. A change republishes the
namespace proxy at once, like a changed domain; on Cloudflare, where there is no
namespace proxy, the next deploy of the environment builds the proxy Worker with it.

A namespace proxy parses its manifest strictly, and `fabrika platform upgrade` does
not move a namespace's proxy source pin. A proxy built from a pin older than the
release that added cross-origin endpoints refuses a manifest whose entry lists
`crossOrigins` or whose row carries `crossOrigin`: the rebuild fails, the previous
proxy version keeps serving, and every deploy that republishes the namespace fails
until the pin moves. Before an application of an upgraded namespace declares
`crossOrigin`, or its environment lists an origin, re-pin the namespace with
`fabrika control namespaces update --namespace=<id> --proxy-source=current`.

Deployment then adds control-owned managed environment values independently of
the namespace and provider artifact. Providers reject an app-authored
`FABRIKA_OPERATIONS_DSN` or `FABRIKA_RELEASE`, inject current values at their
native service boundary, and remove stale values when control sends `null`.
These reserved values do not become resource claims or fields in an opaque
provider envelope.

## Resource claims

`namespace_resource_claims` prevents two owners from declaring the same
provider resource inside one namespace. Its key is
`(namespace_id, resource_key)`.

- A namespace-owned claim has no app or environment owner.
- An app-owned claim names an existing `(app_id, env)` pair.
- Claim ownership is immutable.
- Registration acquires the app-environment row and its claims atomically.
- Namespace creation acquires its reserved claims before provider provisioning.
- Reconcile acquires missing reserved namespace claims before provider mutation.
- Omitted claims are retained. A pre-deploy namespace move therefore leaves a
  historical reservation in the old namespace.
- A claim outlives its owner's deletion. Deleting an application or an
  application environment that still holds one answers **409**, naming the
  namespace and the resource keys that hold it. The claim is not released:
  fabrika deletes no provider resource
  ([ADR-0034](../decisions/0034-the-control-plane-creates-the-projects-it-owns.md)),
  so freeing the name would make the orphaned live service adoptable by the next
  application, carrying its old secrets. Releasing a claim is an undecided
  operator action, not a step the delete performs.

Before a deploy calls the provider, shared lifecycle code rehydrates the stored
namespace and verifies provider, environment, readiness, exclusivity, normalized
coordinates, and every expected claim. A missing or differently owned claim
stops the deploy before any provider effect.

## Zerops mapping

One Zerops deployment namespace maps to one Zerops project. Its namespace target
envelope uses Zerops namespace codec version 1 and stores both policy and durable
progress:

- project name, core package, and public-access mode;
- the proxy's pinned source: public repository, exact commit, and verified `zerops.yaml` descriptor (ADR-0045);
- optional namespace-owned PostgreSQL type and profile;
- managed/adopted ownership and the Zerops project id;
- resolved proxy and PostgreSQL service ids;
- proxy configuration and app-version checkpoints;
- the hosts the published proxy serves, one per HTTP port;
- provider readiness.

The application environment uses a separate Zerops app target envelope, version
2, containing only the app service id. The project id and proxy service id come
from the assigned namespace. Credentials are never stored in either target.

The Zerops artifact envelope is version 2 and contains manifest version 2. Its
`target.importDocument` is the canonical structured import document. Resource
claims and the YAML sent to the Zerops import API are both derived from that same
document. The manifest parser enforces legal and unique service hostnames,
service-level `envIsolation: service`, `override: true`, the absence of embedded
secret fields, and ownership of the proxy upstream.

### Presets

| Preset  | Project ownership                 | Proxy           | PostgreSQL                             |
| ------- | --------------------------------- | --------------- | -------------------------------------- |
| `cheap` | Shared by apps in one environment | Namespace-owned | One namespace-owned `postgres` service |
| `mid`   | Shared by apps in one environment | Namespace-owned | App-owned, prefixed services           |
| `full`  | Exclusive to one app              | Namespace-owned | App-owned services                     |

Every Zerops namespace reserves `service:proxy`. A cheap namespace also reserves
`service:postgres`. Application claims are the service hostnames in the canonical
manifest. Cheap defaults to `postgresql:ha@18` in `prod` and
`postgresql:single@18` elsewhere; its plan options may select a supported type
and profile explicitly.

Apps in shared `cheap` and `mid` namespaces must use the deterministic app prefix
from `zeropsSharedServicePrefix`. A direct lowercase alphanumeric app id up to 12
characters is its own prefix; other ids use a normalized fragment plus a stable
hash. The final service hostname must remain lowercase alphanumeric and at most
25 characters. A full namespace does not require the shared prefix because its
exclusive app owns the entire project.

Cheap-mode consumers declare `useSharedPostgres()`. The manifest records a
requirement for `service:postgres` and the cross-service reference
`${postgres_connectionString}/${postgres_dbName}?sslmode=disable` instead of
declaring a database service. Service-level environment isolation does not block
explicit cross-service references, so a cheap namespace is one shared
PostgreSQL credential trust domain for code. A contract application connects
with neither: its `FABRIKA_APP_DATABASE_URL` is the shared service's superuser,
the provisioning credential that creates its role family, and its migrations and
queries run as that family, which owns or reaches only its `app_<id>` schema
([ADR-0017](../decisions/0017-service-owned-postgres-migrations.md)), so one
application's SQL cannot reach another's tables. No application may reference
the superuser's password.

## Zerops lifecycle and routing

Provisioning creates or recovers a marked Fabrika project, imports the
namespace-owned services with `startWithoutCode`, resolves their ids, writes the
proxy's service-level IAM configuration, deploys the proxy, and checkpoints the
ready target. Adoption validates the supplied project before the first import.
Reconcile repeats the same idempotent lifecycle from the stored checkpoint.

The service import explicitly applies `envIsolation: service` on every
namespace-owned service. Zerops project read responses do not expose the
project-level isolation value, so reconcile cannot observe it; the service-level
setting is reimported as the enforceable control.

Only the namespace proxy is public. Application services remain private. The
proxy manifest contains every public app assigned to that namespace whose
contract Control approved (ADR-0050), keyed by its configured domain and private
upstream, with the endpoint table of that approved contract
(`contractProxyTable`). A member without approved access gets no route, and its
artifact is not read. Before an app deploy, the control plane:

1. verifies namespace coordinates and claims;
2. compiles the proxy manifest from every assigned app with approved access;
3. writes each contract application's proxy secret to the proxy service under
   `proxySecretVariable('<app>@<env>')`;
4. rolls the proxy with the manifest as the data file of its build archive
   ([ADR-0045](../decisions/0045-upload-immutable-platform-and-namespace-proxy-sources.md)), and waits for its
   app version. A namespace pinned to a release whose proxy build lifts `FABRIKA_PROXY_MANIFEST_JSON` gets the
   variable instead, bound by the ~32 KB Zerops value limit, until
   `fabrika control namespaces update --proxy-source=current` re-pins it;
5. applies and deploys the application import, with the same secret as its
   `FABRIKA_PROXY_SECRET`.

The proxy secret authenticates the hop from the proxy to the application, because
every service of a namespace shares one private network (ADR-0022 rule 5). Control
generates it once per application environment, the first time it hands the
environment to its namespace, seals it in the vault, and records only the vault ref
(`app_env_proxy_secrets`). Caddy sends it as `X-Fabrika-Proxy-Secret` through an
`{env.…}` placeholder, so it is in no generated file. Without a vault Control hands no
secret, and the provider refuses a contract application rather than deploy one that
would refuse every request. There is no rotation verb yet.

Custom domains are bound to the namespace's `proxy` service manually in Zerops.
App services do not receive public domains. Zerops subdomain access is available
as the non-production `zerops-subdomain` namespace option.

A `zerops-subdomain` namespace publishes one generated host per listening proxy
port. The platform names them in the proxy service's READ_ONLY `zeropsSubdomain`
variable as newline-separated URLs; provisioning and reconcile read that variable
after the subdomain is published and record `{ host, port }` in the namespace
target, so reading a namespace costs no platform call. A placement provisioned
before the hosts were recorded lists none until its next reconcile. A
`custom-domain` namespace records none either: its domains are bound out of band
and the provider cannot see them. A listing that fails leaves the namespace ready
with no hosts and one warning line — the proxy is already built, deployed and
published, and a host listing is not worth failing a working placement over.

Because the proxy routes by HOST, an application environment whose manifest
carries a `target.proxy` must have a domain. Registration and
`apps.environments.put` refuse one that does not, naming `--domain`, from
the provider's synchronous claims hook — before any provider mutation, so nothing
is created. Previously such a registration succeeded and its first deploy failed
at proxy composition.

The proxy source pin is persisted in the namespace target when the namespace is
planned and every proxy build uploads exactly that source (ADR-0045). A target
without a pin does not decode.

## Operator interfaces

All namespace RPC procedures at `/api/rpc` require the global `namespace.manage` action:

| RPC procedure          | Operation                                          |
| ---------------------- | -------------------------------------------------- |
| `namespaces.list`      | List namespaces and provider-owned preset metadata |
| `namespaces.plan`      | Produce a mutation-free provider plan              |
| `namespaces.create`    | Persist claims and queue provisioning              |
| `namespaces.get`       | Read state, presentation, and served hosts         |
| `namespaces.adopt`     | Adopt and reconcile an existing placement          |
| `namespaces.reconcile` | Queue a reconcile of stored provider state         |
| `namespaces.update`    | Change a ready placement's target in place         |
| `namespaces.remove`    | Remove an unused placement and free its id         |

Update is synchronous and accepts only what the provider can change in place. Its
payload may name only what changes; the provider merges it over the stored
target and refuses a field the target does not have — a misspelt `corePakage`
or a `postgres.maxContainers` — with 400 before any provider call. On Zerops the
one field that changes in place is the PostgreSQL profile: the provider moves
the live service through `PUT /service-stack/{id}/autoscaling`, because a
re-import ignores a changed profile, and confirms the new profile by reading the
service back, within about 90 s. A provider without an update capability
refuses every update by name.

Any other change — the PostgreSQL type included — is refused with 409. Removing
the namespace and creating the same id again does not help: removal keeps the
provider project and its database
([ADR-0034](../decisions/0034-the-control-plane-creates-the-projects-it-owns.md)),
and creation finds that project by its ownership marker, adopts the existing
PostgreSQL service and fails on its type. The supported path is a new namespace:
`namespaces.create` under a new id with the new target, move each application
environment and its data to it by hand, then `namespaces.remove` the old one.

Under the namespace lease, the row is first marked: state `failed`, the code
`namespaceUpdateUnconfirmed`, and the planned target, which `namespaces.get`
returns as `unconfirmedTarget`. While the lease is held, a second update answers
409. Success stores the new target and `ready` in one fenced write; a definite
failure restores the row as it was. An outcome the provider cannot confirm — the
platform accepted the change and the read-back did not settle, the request was
cut off, or Control stopped — leaves the mark in place. The way out is to retry
`namespaces.update`: with `unconfirmedTarget` it finishes the update, and with
the previous target it moves the service back. A live service on either the
stored or the planned profile is read as the change in progress, so the retry
converges whether or not the live change applied. The console's editor starts
from `unconfirmedTarget`.

While the mark stands, the namespace refuses every operation that would write
its row, each with an error that names the retry:

- Reconcile and removal answer 409, in their SQL as well as in the request.
- A deploy into the namespace fails before the provider deploys.
- A proxy republish is refused. A republish writes the row `provisioning` and
  then `ready`, which would erase the mark and with it the only record that the
  live service may disagree with the stored target. Refusing is the simpler of
  the two safe options; the other, keeping the mark through every proxy
  checkpoint, is not built.

A repair requested meanwhile is not lost. A republish or reconcile that meets
the mark records the request on the row (`repair_requested`), and the write that
clears the mark lands `pending` instead of `ready` and queues a `reconcile` job,
which rebuilds the proxy from the current members.

Removal is the narrow case only. It is refused while any application environment
is registered in the namespace, naming the applications, and while a worker is
still settling it; `pending`, `failed`, and `ready` namespaces without registered
environments are removable. It deletes the row and releases its resource claims
in one transaction, which frees the id for reuse — the same id the provider's own
marker-based recovery is keyed to, so a failed first attempt is retried under its
original name rather than stranding what it created. It deletes no provider
resource: the control plane holds `OWNER` on the projects it creates
([ADR-0034](../decisions/0034-the-control-plane-creates-the-projects-it-owns.md)),
so the response returns the removed row whole. A provider marks the presentation
facts that name a live resource rather than a policy choice; the console and the
CLI report exactly those as retained, and report nothing when none is marked.

Reading one namespace also answers its `hosts`: for every host the provider
names, the port that publishes it and, when a registered environment's domain
already equals it, the `appId` and `environment` that took it. The match is on the
domain the proxy manifest routes on, so a host reported free is exactly one the
next `--domain` may claim. The field is absent where the provider names no host.

Application onboarding and `apps.environments.put` accept `namespaceId`.
The response exposes that assignment alongside opaque provider target and
artifact envelopes.

The public `fabrika` CLI dispatches these commands to the Zerops provider:

```text
fabrika namespace plan --provider=zerops --id=<id> --env=<env> --preset=<cheap|mid|full>
fabrika namespace create --provider=zerops --id=<id> --env=<env> --preset=<cheap|mid|full>
fabrika namespace adopt --provider=zerops --id=<id> --env=<env> --preset=<cheap|mid|full> --project-id=<id>
fabrika namespace reconcile --provider=zerops --id=<id>
```

The CLI plan is local and uses the same provider operator implementation. Create
and adopt submit the resulting envelope to the control API; reconcile invokes
the stored lifecycle. CLI options cover project name, core package, public
access, PostgreSQL type/profile, exclusive app, and proxy source. Output follows
`fabrika control namespaces`: `plan` prints one `<path>\t<value>` row per field,
the other commands one namespace row, and `--json` prints the result as JSON.

The dashboard exposes namespace list, plan/review/create, detail, reconcile, and
removal flows. A failed placement renders its failure code beside the message.
Removal confirms against the provider facts it will leave behind. Its namespace signature renders only provider-authored safe facts and
instructions. The app detail screen lists compatible `ready` namespaces and
allows a pre-deploy assignment change without interpreting the app's provider
envelopes.
