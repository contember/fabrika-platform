# Zerops — the platform facts fabrika depends on

The subset of Zerops behaviour that the decisions in
[`../decisions/`](../decisions/README.md) rest on. Every claim carries a source.
Where a claim could **not** be confirmed in the public docs it says so — do not
promote it to fact without checking.

## Hierarchy and isolation

`project → service → container`. A project is the top-level entity: a **VXLAN
private network** with dedicated L3/L7 balancers, internal DNS, a firewall, and a
logger container. Services within a project share that private network and reach
each other directly by hostname and internal port (e.g. `http://api:3000/health`);
service discovery is automatic.
([infrastructure](https://docs.zerops.io/features/infrastructure),
[internal access](https://docs.zerops.io/references/networking/internal-access))

**Isolation is between projects, not within one.** "To connect to a service from
another Zerops project, you'll need to use public access methods since different
projects don't share private networks."
([internal access](https://docs.zerops.io/references/networking/internal-access))

The `envIsolation` setting governs **environment-variable visibility between
services**, not network reachability — a service with isolation on is still
reachable by hostname from every other service in the project. It is a real field at
BOTH project and service level, with two values: `none` (every service sees every
variable) and `service` (each service sees only its own); a service-level value
overrides the project's, and "explicit variable referencing is still possible
regardless of the isolation setting". The cross-service reference mechanism is
prefixing the key with the service hostname, e.g. `mariadb1_connectionString`
([import JSON schema](https://api.app-prg1.zerops.io/api/rest/public/settings/import-project-yml-json-schema.json),
[env variables](https://docs.zerops.io/nodejs/how-to/env-variables)).

The public project read response does not expose the project's `envIsolation`
setting, so a client cannot verify that value after creation. Fabrika writes
`envIsolation: service` on every managed service and reimports those service
definitions during namespace provision and reconcile.

## Public access

Services are **not publicly accessible by default**: "By default, your services are
not publicly accessible until you configure external access." Public access is
opt-in per service, via a Zerops subdomain (`*.zerops.app`, explicitly "not
suitable for production"), a custom domain, or direct TCP/UDP port access. The
project's **L7 HTTP balancer handles domain routing and SSL termination**.
([access & networking](https://docs.zerops.io/features/access),
[import reference](https://docs.zerops.io/references/import) for
`enableSubdomainAccess`, default `false`)

Whether **multiple custom domains** may point at a single service is not stated on
the access page. Fabrika does not automate custom-domain binding: the operator
binds each application domain to its namespace's `proxy` service in Zerops.

## corePackage

`corePackage` is a **per-project** tier: `LIGHT` (default, limited redundancy) or
`SERIOUS` (HA). It "can be upgraded later from Lightweight to Serious Core, but
cannot be downgraded"; upgrades cause a brief disruption and are partially
destructive (logs and statistics are lost).
([import reference](https://docs.zerops.io/references/import))

Fabrika sets `corePackage` per deployment namespace project. The provider default
is `SERIOUS` for `prod` and `LIGHT` for other environments.

## The two config files

| File                 | Role                                                                                                                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `zerops-import.yaml` | Infrastructure-as-Code: projects, services, autoscaling, env variables, `buildFromGit`, and an inline `zeropsYaml:` object that supplies (or overrides) what would otherwise come from the repo. |
| `zerops.yaml`        | Build/run descriptor, normally committed to the app repo.                                                                                                                                        |

`zerops.yaml` fields used by fabrika: `build.{base, prepareCommands, buildCommands,
deployFiles, cache}` and `run.{base, os, prepareCommands, initCommands, start,
ports, healthCheck}`, plus `envVariables` on both. `run.initCommands` runs "each time
a new runtime container starts or restarts" (in `/var/www`) — that is where
migrations go on Zerops.
([zerops.yaml specification](https://docs.zerops.io/zerops-yaml/specification),
[import reference](https://docs.zerops.io/references/import))

A published JSON schema exists for the import format:
`https://api.app-prg1.zerops.io/api/rest/public/settings/import-project-yml-json-schema.json`
([import reference](https://docs.zerops.io/references/import)).

Caveat on `buildFromGit`: the documented form takes a **public** repository URL —
private repos fail during clone
([import reference](https://docs.zerops.io/references/import)). Private-repo builds
go through the GitHub/GitLab integration instead
([GitHub integration](https://docs.zerops.io/references/github-integration)).

Fabrika persists the proxy's public `buildFromGit` URL in the namespace target
and reuses it for proxy pipeline triggers. The public documentation does not
establish that this URL is an immutable content pin.

## Zerops has its own CI

There is a build container with a real filesystem and shell:

- CPU 1–5 cores, RAM 8 GB (min and max), disk 1–100 GB; containers start at the
  minimum and scale vertically.
- The whole build pipeline has a **1 hour** limit.
- "Build container resources are not charged. Build costs are covered by the
  standard Zerops project fee."

Triggers: git push to a selected branch, tag creation (GitHub/GitLab CD),
`zcli service push`, `zcli service deploy` (deploy-only, skips build), a manual GUI
trigger, and `buildFromGit` in an import YAML.

Zerops keeps the **10 most recent versions** of an application and can activate an
archived one (rollback) from the GUI.
([build & deploy pipeline](https://docs.zerops.io/features/pipeline))

This is the single fact that removes the need for a fabrika deploy runner on Zerops
— see [ADR-0003](../decisions/0003-no-deploy-runner-on-zerops.md). The design
conversation also described the build container as Incus-based full Linux; the
Incus detail is **not stated** on the pipeline page.

## REST API

Base URL `https://api.app-prg1.zerops.io/api/rest/public`, Bearer auth with a
**personal access token** generated in the GUI. The token is sent verbatim — there is
no exchange step; `/auth/*` is for email+password sessions, not for a PAT.
([REST API reference](https://docs.zerops.io/references/api))

**A machine-readable OpenAPI document exists** and is the authoritative contract for
every request/response shape:
`https://api.app-prg1.zerops.io/api/rest/public/swagger/openapi.yml` (served behind
the Swagger UI at `/swagger`; `/openapi.json` and `/swagger.json` both 404). Prefer it
over prose. The endpoints fabrika's Zerops provider uses, all confirmed there:

| Purpose                                | Endpoint                                                                   | Body / response                                                                                  |
| -------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Apply an import to an existing project | `POST /project/{id}/service-stack/import`                                  | `{ yaml }` → `{ projectId, projectName, serviceStacks[] }`                                       |
| Create a project from an import        | `POST /client/{id}/project/import`                                         | same shapes                                                                                      |
| Trigger build+deploy                   | `PUT /service-stack/{id}/trigger-pipeline`                                 | `{ buildFromGit?, zeropsYaml?, zeropsSetup?, startWithoutCode?, userData?, … }` → `{ process? }` |
| Poll a version                         | `GET /app-version/{id}`                                                    | `{ id, status, sequence, serviceStackId, build{…} }`                                             |
| List versions                          | `GET /service-stack/{id}/app-version`                                      | `{ list[], totalCount }`, `limit`/`offset`/`statuses`                                            |
| Cancel a build                         | `PUT /app-version/{id}/cancel-build`                                       | → `{ success }`                                                                                  |
| Service-level env vars                 | `GET`/`POST /service-stack/{id}/user-data`, `PUT`/`DELETE /user-data/{id}` | `{ key, content }`                                                                               |
| Project-level env vars                 | `POST /project/{id}/env`, `PUT /project-env/{id}`                          | `{ key, content, sensitive }` — **fabrika never calls these** (ADR-0004)                         |
| Log access                             | `GET /project/{id}/log`                                                    | `{ accessToken, expiration, url, urlPlain, urlInfo, urlUi }`                                     |

`app-version.status` is a closed enum: `UPLOADING`, `WAITING_TO_BUILD`, `BUILDING`,
`BUILD_FAILED`, `BUILD_VALIDATION_FAILED`, `WAITING_TO_DEPLOY`, `DEPLOYING`,
`DEPLOY_FAILED`, `PREPARING_RUNTIME`, `PREPARING_RUNTIME_FAILED`, `ACTIVE`, `BACKUP`,
`CANCELLED`. `ACTIVE` is the only success.

The OpenAPI document has these relevant limits:

- **The log service itself.** `GET /project/{id}/log` returns URLs plus a bearer for a
  SEPARATE service; that service's own request/response contract appears in no
  published document. fabrika's client marks `readBuildLog` unverified and treats a
  failure there as non-fatal.
- **Project `envIsolation` is write-only through the relevant public shapes.** It
  is settable on `POST /client/{id}/project` and in the import `project:` section,
  absent from `RequestPutProject`, and absent from the project read response.
  Service-level `envIsolation` is importable and overrides the project setting;
  Fabrika reapplies it during namespace reconciliation.

**The personal access token carries account-wide admin privileges** — no finer
scoping was found. Treat it as a root credential: it is the single most dangerous
thing a fabrika installation on Zerops holds.

## Environment variables

Two levels: **project-level** variables, "available to all services in the project",
and **service-level** variables, including secret variants (`envSecrets` as a map,
`dotEnvSecrets` as a multiline `.env` block). Secrets are blurred in the GUI and can
be edited or deleted there. Secret and project variables can change **without a
redeploy**.
([import reference](https://docs.zerops.io/references/import),
[env variables](https://docs.zerops.io/nodejs/how-to/env-variables))

Project-level injection into every service is exactly why
[ADR-0004](../decisions/0004-secrets-live-in-the-platform.md) forbids fabrika from
ever putting an app secret at project level.

The public contract does not establish a secret-value read-back operation.

## Fabrika placement mapping

The Fabrika platform project contains:

- `iam`, `operations`, `control`, and the only public `proxy` runtime;
- one shared `db` PostgreSQL service for IAM and control;
- a separate `operationsdb` PostgreSQL service for Operations;
- private `storage` for run logs and `operationsstorage` for raw events and
  source maps.

IAM, Operations, and control deploy in that dependency order. Operations uses
`run.initCommands` for service-owned plus `platform-node` queue migrations,
`run.start` for its HTTP server and Postgres job consumer, and `run.crontab` for
health and notification maintenance. Its database and object store are separate
failure/capacity domains from IAM and control.

The platform proxy routes the configured Operations public hostname only to
Sentry envelope ingest and authenticated source-map upload. The operator API,
catalog/release sync, health endpoint, and Operations-to-IAM RPC stay on the
private project network. Custom-domain binding remains a manual real-account
step covered by
[backlog 05](../backlog/05-bring-up-on-a-real-zerops-account.md).

One Fabrika deployment namespace maps to one Zerops project and its
namespace-owned proxy. The optional namespace-owned `postgres` service is present
for the `cheap` preset. The app target envelope version 2 stores only its service
id; the namespace target envelope version 1 supplies project, proxy, policy, and
durable lifecycle coordinates. The app artifact envelope version 2 stores
manifest version 2 with the structured import document used for claims and API
YAML.

The full lifecycle, isolation presets, shared PostgreSQL trust domain, and
operator interfaces are described in
[`deployment-namespaces.md`](deployment-namespaces.md).

Before each application deploy, control writes managed
`FABRIKA_OPERATIONS_DSN` and `FABRIKA_RELEASE` values at service scope. Those
values are not part of the app's static import document or provider envelope.

## Alpine custom runtime

Zerops has an Alpine service type: "a minimal base environment for running
applications built with technologies that aren't officially supported by Zerops, or
for custom setups requiring full control over the runtime environment". Combined
with an `alpine@3.x` **service type**, `run.base`, `run.prepareCommands` (which run in
a fresh base container) and an arbitrary `run.start`, a **static binary is a
first-class deployment target**.
([Alpine overview](https://docs.zerops.io/alpine/overview),
[zerops.yaml specification](https://docs.zerops.io/zerops-yaml/specification))

**Two fields the import JSON schema marks deprecated**, so don't reach for them: `mode`
("use Type version only" — availability is encoded in the service type, e.g.
`postgresql:ha@18` vs `postgresql:single@18`) and `os` (survives only for a
`startWithoutCode` runtime service; select an `alpine@3.x` type instead of setting it).

This is what makes the Caddy proxy deployable —
[ADR-0008](../decisions/0008-caddy-forward-auth-proxy.md). Since the project L7
balancer terminates TLS, Caddy needs neither ACME nor certificate persistence.
