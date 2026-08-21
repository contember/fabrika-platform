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
instructions. Shared control validates that planning and normalization preserve
the namespace id, environment, exclusive owner, and provider id.

The namespace lifecycle reports durable provider checkpoints through
`ProviderNamespaceEvents.checkpoint`. Shared control persists each checkpoint
before the provider continues to its next external mutation.

The provider mutation does not run inside the request. `create`, `adopt`, and
`reconcile` persist the row, enqueue a namespace job on the control queue, audit,
and answer `pending`; a worker then claims `pending` to `provisioning`, runs the
provider mutation with its own signal, and records `ready` or `failed`. A caller
polls `GET /api/namespaces/:id` and may disconnect without affecting the outcome.
A namespace left `provisioning` by a crashed worker is resumed from its
checkpoints, and a job for a namespace that already settled is a no-op.
`reconcile` on a namespace that is still settling only enqueues: it never rewrites
the provider target, because a job in flight may be checkpointing it.

## Persistence and assignment

`deployment_namespaces` stores:

- id, environment, provider, and optional exclusive app id;
- the provider target envelope;
- lifecycle state: `pending`, `provisioning`, `ready`, or `failed`;
- the last bounded lifecycle error.

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

Before a deploy calls the provider, shared lifecycle code rehydrates the stored
namespace and verifies provider, environment, readiness, exclusivity, normalized
coordinates, and every expected claim. A missing or differently owned claim
stops the deploy before any provider effect.

## Zerops mapping

One Zerops deployment namespace maps to one Zerops project. Its namespace target
envelope uses Zerops namespace codec version 1 and stores both policy and durable
progress:

- project name, core package, and public-access mode;
- the proxy's public `buildFromGit` source;
- optional namespace-owned PostgreSQL type and profile;
- managed/adopted ownership and the Zerops project id;
- resolved proxy and PostgreSQL service ids;
- proxy configuration and app-version checkpoints;
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
`${postgres_connectionString}` instead of declaring a database service. Every
consumer receives the same provider-issued service credential. Service-level
environment isolation does not block explicit cross-service references, so a
cheap namespace is one shared PostgreSQL credential trust domain.

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
proxy manifest contains all public apps assigned to that namespace, keyed by
their configured domains, private upstreams, and ordered authorization gates.
Before an app deploy, the control plane:

1. verifies namespace coordinates and claims;
2. compiles the proxy manifest from every assigned app;
3. writes it to the proxy service-level
   `FABRIKA_PROXY_MANIFEST_JSON` variable;
4. rolls the proxy and waits for its app version;
5. applies and deploys the application import.

Custom domains are bound to the namespace's `proxy` service manually in Zerops.
App services do not receive public domains. Zerops subdomain access is available
as the non-production `zerops-subdomain` namespace option.

The proxy `buildFromGit` URL is persisted in the namespace target and reused for
proxy pipeline triggers. Public Zerops documentation does not establish that
this source is an immutable content pin; operators must treat the configured URL
as the source identity rather than a publicly verified immutable revision.

## Operator interfaces

All namespace HTTP routes require the global `namespace.manage` action:

| Method and path                      | Operation                                          |
| ------------------------------------ | -------------------------------------------------- |
| `GET /api/namespaces`                | List namespaces and provider-owned preset metadata |
| `POST /api/namespaces/plan`          | Produce a mutation-free provider plan              |
| `POST /api/namespaces`               | Persist claims and queue provisioning              |
| `GET /api/namespaces/:id`            | Read lifecycle state and provider presentation     |
| `POST /api/namespaces/:id/adopt`     | Adopt and reconcile an existing placement          |
| `POST /api/namespaces/:id/reconcile` | Queue a reconcile of stored provider state         |

Application onboarding and `PUT /api/apps/:app/envs/:env` accept `namespaceId`.
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
access, PostgreSQL type/profile, exclusive app, and proxy source.

The dashboard exposes namespace list, plan/review/create, detail, and reconcile
flows. Its namespace signature renders only provider-authored safe facts and
instructions. The app detail screen lists compatible `ready` namespaces and
allows a pre-deploy assignment change without interpreting the app's provider
envelopes.
