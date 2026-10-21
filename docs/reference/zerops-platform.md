# Zerops — the platform facts fabrika depends on

The subset of Zerops behaviour that the decisions in
[`../decisions/`](../decisions/README.md) rest on. Every claim carries a source.
Where a claim could **not** be confirmed in the public docs it says so — do not
promote it to fact without checking.

## How a fact here becomes verified

The `### Verified live` sections below were produced by hand against a real account; the table in
`packages/provider-zerops/src/__tests__/platform-facts.ts` is what re-checks them. It is the
machine-readable half of this document: one row per fact — the request, the expected status and error
code, and the section here it came from. Two consumers run that ONE table:

- `packages/local-stack/src/__tests__/zerops-emulator.test.ts` runs every row marked `emulator: true`
  against the local double, so a fact added for the platform is asserted of the emulator in the same
  change.
- `packages/provider-zerops/src/__tests__/platform-facts.live.test.ts` runs every row that is not
  `not-probed` against a real account, behind `FABRIKA_LIVE_ZEROPS_TOKEN` and
  `FABRIKA_LIVE_ZEROPS_PROJECT_ID` (plus `FABRIKA_LIVE_ZEROPS_SLOW=1` for the build-length rows).
  It creates throwaway services named with a run id and deletes them again.

**Adding a fact means adding a row**, not only a line in a table here. A row marked `live:
'not-probed'` carries the reason it cannot be probed — a second credential, a build, a race, or a
network the suite cannot reach — and a row marked `emulator: false` carries the reason the double does
not model it.

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

Because the balancer terminates TLS and routes domains, a service behind it sees
the **balancer** as its socket peer, not the client. Whether the balancer
forwards a client address, whether it drops a caller-supplied `X-Forwarded-For`
prefix, and what source range it dials from are **all unconfirmed** — the public
docs say nothing, and no live run has measured it. Fabrika therefore configures
no Caddy `trusted_proxies` range, so `{http.vars.client_ip}` is the balancer
and every client shares one abuse bucket. Settling it is a live-account question
([backlog 05](../backlog/05-bring-up-on-a-real-zerops-account.md)); until then do
not promote a forwarded address to a limiter key.

## corePackage

`corePackage` is a **per-project** tier: `LIGHT` (default, limited redundancy) or
`SERIOUS` (HA). It "can be upgraded later from Lightweight to Serious Core, but
cannot be downgraded"; upgrades cause a brief disruption and are partially
destructive (logs and statistics are lost).
([import reference](https://docs.zerops.io/references/import))

Fabrika sets `corePackage` per deployment namespace project. The provider default
is `LIGHT` on every environment, `prod` included
([ADR-0038](../decisions/0038-size-namespaces-cheaply-by-default.md)); `SERIOUS` is
an explicit `--core-package=SERIOUS`.

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

Fabrika persists the proxy's public repository, exact commit and verified descriptor in the namespace
target, then uploads that source to an explicitly reserved version (ADR-0045). A target without that
pin does not decode, and an installation-default change does not replace a namespace pin.

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

| Purpose                                | Endpoint                                                             | Body / response                                                                                  |
| -------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Apply an import to an existing project | `POST /project/{id}/service-stack/import`                            | `{ yaml }` → `{ projectId, projectName, serviceStacks[] }`                                       |
| Create a project from an import        | `POST /client/{id}/project/import`                                   | same shapes                                                                                      |
| Trigger build+deploy                   | `PUT /service-stack/{id}/trigger-pipeline`                           | `{ buildFromGit?, zeropsYaml?, zeropsSetup?, startWithoutCode?, userData?, … }` → `{ process? }` |
| Poll a version                         | `GET /app-version/{id}`                                              | `{ id, status, sequence, serviceStackId, build{…} }`                                             |
| List versions                          | `GET /service-stack/{id}/app-version`                                | `{ list[], total }`, `limit`/`offset`/`statuses`                                                 |
| Cancel a build                         | `PUT /app-version/{id}/cancel-build`                                 | → `{ success }`                                                                                  |
| Read a service's env vars              | `GET /service-stack/{id}/env`                                        | → `{ items[] }`, each `{ id, key, content, type, sensitive }`                                    |
| Write a service-level env var          | `POST /service-stack/{id}/user-data`, `PUT`/`DELETE /user-data/{id}` | `{ key, content }` — `PUT` needs BOTH fields                                                     |
| Project-level env vars                 | `POST /project/{id}/env`, `PUT /project-env/{id}`                    | `{ key, content, sensitive }` — **fabrika never calls these** (ADR-0004)                         |
| Log access                             | `GET /project/{id}/log`                                              | `{ accessToken, expiration, url, urlPlain, urlInfo, urlUi }`                                     |

Paged lists (`/client/{id}/project`, `/project/{id}/service-stack`, `/service-stack/{id}/app-version`,
`/service-stack/{id}/user-data`) answer `{ list, count, total, limit, offset }`. Until at least
2026-08-21 they answered `{ list, totalCount }`; on 2026-10-12 every one of them answered `total`
and no `totalCount`, which stopped `platform install` at its first service listing. The client
pages by `total`.

`app-version.status` is a closed enum: `UPLOADING`, `WAITING_TO_BUILD`, `BUILDING`,
`BUILD_FAILED`, `BUILD_VALIDATION_FAILED`, `WAITING_TO_DEPLOY`, `DEPLOYING`,
`DEPLOY_FAILED`, `PREPARING_RUNTIME`, `PREPARING_RUNTIME_FAILED`, `ACTIVE`, `BACKUP`,
`CANCELLED`. `ACTIVE` is the only success.

The OpenAPI document has these relevant limits:

- **The log service itself.** `GET /project/{id}/log` returns URLs plus a bearer for a
  SEPARATE service; that service's own request/response contract appears in no
  published document. What it does answer was measured live — see "the project log
  service" below; fabrika's client (`readBuildLog`) treats a failure there as non-fatal.
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

### Verified live (2026-08-03, account `prg1`)

The following were confirmed against a real account and are no longer inferences.

| Behaviour                                                                           | Result                                                                                                                         |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| A variable written through the env API resolves `${service_var}` at container start | **Yes** — identical to one written in `run.envVariables`                                                                       |
| A BUILD container can read its service's env-API variables directly                 | **No** — every one reads as the empty string, silently                                                                         |
| `build.envVariables: { X: '${RUNTIME_X}' }` lifts them into the build               | **Yes**, and it resolves nested references too                                                                                 |
| `GET /service-stack/{id}/user-data`                                                 | **Always 400 `serviceStackNotFound`**, before AND after a successful deploy — **SUPERSEDED, see 2026-08-21 below**             |
| `POST /service-stack/{id}/user-data`                                                | Works from the moment the service exists                                                                                       |
| `POST /user-data/search` (with `clientId` **and** `serviceStackId`)                 | Works, but is not in the published OpenAPI document and needs a `clientId` — see `/env` below                                  |
| Secret value read-back                                                              | **SUPERSEDED, see 2026-10-15 below:** a sensitive value reads `REDACTED` outside sudo mode                                     |
| `run.envVariables` visible through the search endpoint                              | Yes, as `type: ENV`                                                                                                            |
| Custom variables prefixed `ZEROPS_`                                                 | **Refused** — 400 `userDataZeropsPrefixForbidden`. The prefix is reserved                                                      |
| `zeropsSetup` in an import without `buildFromGit`                                   | **Refused** — 400 `projectImportInvalidParameter`, `{"iam.buildFromGit": ["parameter is required for use of pipelineConfig"]}` |
| Enabling subdomain access on a never-deployed service                               | **Refused** — "Service stack is not http or https". Needs a deployed HTTP port first. See the 08-05 section below              |
| One generated subdomain per HTTP port                                               | **Yes** — `<hostname>-<hash>-<port>.<region>.zerops.app`                                                                       |
| A version alias such as `alpine/bun@1.3`                                            | Resolves to the newest concrete version (`1.3.9`). `zops catalog` lists only concrete ones                                     |
| `alpine/go@latest` building Caddy 2.10.2                                            | **Works** — the base is Go 1.22 and Go's automatic toolchain download supplies the rest                                        |

Two consequences worth stating separately, because they are ordering constraints
rather than facts about a field:

- **Never read before writing a service variable.** ~~The list endpoint's 400 is
  not "no such service" and not "not deployed yet" — it never succeeds.~~
  **SUPERSEDED 2026-08-21**: the endpoint answers a list. The ordering rule
  survives it for a different reason — the create must work on a service that has
  never been deployed, which is ADR-0004's bring-up order — and the client still
  reads `/env`, because that is where the record ids it writes with come from.
- **A second deploy cannot start while a `userData` synchronisation is running**
  ("Process of synchronizing userData is already running"). Writing variables and
  then immediately pushing needs a retry loop. This does NOT apply to the writes
  themselves — see below.

### Verified live (2026-08-05, account `prg1`, project `fabrika-test`)

Written while fixing the write path. Every row was produced with `zops` against the
live account; the operation ids are `zops api --list --tag UserData`.

| Behaviour                                                                   | Result                                                                                                                                                         |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /service-stack/{id}/user-data` (`ListServiceStackUserData`)            | **Still always 400 `serviceStackNotFound`** — **SUPERSEDED, see 2026-08-21 below**: it answers a list now                                                      |
| `POST /service-stack/{id}/user-data` (`CreateUserData`)                     | Works. Returns a **process**, not the created record — the new record's id is not in the response                                                              |
| `POST` on a key the service already has                                     | **400 `userDataDuplicateKey`**, "not unique in service stack frame of reference". Nothing is written; it does not replace                                      |
| **`GET /service-stack/{id}/env` (`GetServiceStackEnvList`)**                | **Works on every service** — ACTIVE, managed (`db`, `storage`) and a stopped build runtime alike. This is the read path                                        |
| The `id` in that response                                                   | **Is the user-data record id** — the same value `POST /user-data/search` returns, and accepted by `PUT`/`DELETE /user-data/{id}`                               |
| `PUT /user-data/{id}` (`UpdateUserDataById`)                                | **Replaces in place**: same record id, new `content`, `lastUpdate` moves. Non-destructive — no delete window exists                                            |
| `PUT /user-data/{id}` with `content` but no `key`                           | **Refused** — 400 `invalidUserInput`. Both fields are required even when the key is unchanged                                                                  |
| `GET /user-data/{id}` (`GetUserDataById`)                                   | Works — a single record by id, unlike the list                                                                                                                 |
| Three `POST`s to one service back to back                                   | **All three succeed.** The "synchronizing userData is already running" conflict gates a DEPLOY, not another write                                              |
| `type: ENV` variables (from the service's `zerops.yaml` `run.envVariables`) | **Absent from `/env`, present in `POST /user-data/search`** — and they still make a `POST` answer `userDataDuplicateKey`. **SUPERSEDED, see 2026-10-13 below** |
| The error envelope                                                          | `{ error: { code, message, meta[] } }`. `code` is a stable identifier; `message` can quote the value it rejected                                               |

**2026-10-13, project `fabrika-v03-apps-mid`:** `/env` now lists a deployed version's `run.envVariables`
too, as `type: USER` records indistinguishable in shape from env-API records, and
`DELETE /user-data/{id}` on one answers **400 `userDataDeleteForbidden`** ("Deleting a system environment
variable is forbidden"). A deploy may therefore delete only keys no descriptor can carry; the managed keys
qualify because an app descriptor may not author them, and `FABRIKA_RELEASE`, which the descriptor does
carry, is never deleted.

Consequences:

- **`GET /service-stack/{id}/env` is the read path, not `POST /user-data/search`.**
  The search endpoint works, but it is absent from the published OpenAPI document
  (`zops` declares it from the zerops-go SDK) and it requires a `clientId` term —
  `{"search":[{"name":"serviceStackId",…}]}` alone answers
  `400 invalidUserInput: clientId not defined`. `/env` is published, is keyed by the
  service alone, and hands back the same record ids. No `clientId` needs to reach
  the API client.
- **Create-or-update is write-first**: `POST`, and only on `userDataDuplicateKey`
  read `/env` for the record id and `PUT /user-data/{id}` with `key` AND `content`.
  Delete-then-create is **not** needed — `PUT` replaces in place, so there is no
  window where the variable is missing.
- **Init credential repair is create-only.** Missing RPC and GitHub variables use
  `POST /service-stack/{id}/user-data` once and never follow a duplicate with
  `PUT`. A duplicate or ambiguous result is accepted only when a bounded `/env`
  reread returns the exact intended value. This prevents init from overwriting a
  credential written by another operator.
- **A key the service declares in its own `zerops.yaml` cannot be written through
  this API.** It conflicts on `POST` yet never appears in `/env`, so the conflict
  cannot be resolved to a record id. Fabrika refuses rather than guessing; replacing
  it would be undone by the next deploy anyway.
- **An error's `code` is safe to keep, its `message` is not.** A validation failure
  can quote the rejected value, so a client that writes secrets must drop the message
  and keep the code — otherwise it cannot tell a duplicate key from a missing service
  without leaking.

### Verified live (2026-08-05, account `prg1`, project `fabrika-test`) — import semantics, sizing, probes, DSN

Produced with `zops` against the live account, on **throwaway services created and deleted for the
purpose** (`wu2db`, `wu2st`, `wu2app`, `wu2ha`) so no platform service was touched. The apply command
is `zops api ImportServiceStack --param id=@project --project fabrika-test --body-file <doc>` in every
row below.

#### `override` is a name-collision escape, not an update and not a replace

**Precondition, measured 2026-08-21: both no-op rows below hold only for a document that does NOT carry
`startWithoutCode`.** That flag asks for an EMPTY DEPLOY, and it does so every time the document is
applied — so a `startWithoutCode` service imports with TWO processes (`stack.create` and `stack.deploy`)
and every later re-apply with `override: true`, unchanged or with a changed `maxContainers`, starts exactly
one `stack.deploy` more. It is the same fact as "re-importing a `startWithoutCode` document at a service
that HAS code is destructive", seen before there is any code to lose. Without the flag an import starts one
`stack.create`, the service settles at **`READY_TO_DEPLOY`**, an unchanged re-apply answers
`processes: []`, and a re-apply carrying `maxContainers: 3` answers `processes: []` with the read-back
`horizontalAutoscaling.maxContainerCount` unmoved at its default of 10. Every fabrika provisioning document
carries `startWithoutCode`, so **no fabrika re-import is a no-op** — it re-activates an empty version.

| Behaviour                                                                           | Result                                                                                                                    |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Re-applying an UNCHANGED document with `override: true`                             | **Complete no-op.** Same service ids, no processes, `lastUpdate` does not move — on managed AND runtime services alike    |
| Re-applying with a CHANGED field (`profile`, `maxContainers`, `objectStorageSize`)  | **Silently ignored.** `zops service export` reads back the original values; no process runs, no error is returned         |
| Re-applying the same document with `override` REMOVED                               | **400 `serviceStackNameUnavailable`**, "Project has already serviceStack with the same name" — and the WHOLE import fails |
| That rejection on a MANAGED service                                                 | **Yes.** It fired on `postgresql:single@18` before any runtime service in the document was reached                        |
| `override: true` on a managed service                                               | **Accepted.** Carried on `postgresql` and `object-storage` through six applies with no error                              |
| Re-applying a document carrying `startWithoutCode: true` at a service that HAS code | **Destructive.** Starts `stack.deploy`, activates a new EMPTY app version; the running one becomes `BACKUP`               |

Consequences:

- **Upstream is wrong twice.** `override` is documented as runtime-services-only and as a _replace_
  that forces a redeploy. On this account it applies to every service class, it is REQUIRED on managed
  ones for a document to be re-appliable at all, and it replaces nothing.
- **Fabrika writes it on every service** (`compile.ts`), and `assertZeropsInvariants` now refuses a
  document without it. The claim it supports is "re-appliable", never "reconciling": an import cannot
  converge an existing service, so a field that must change is changed through the API that owns it
  (`PUT /service-stack/{id}/autoscaling`, `UpdateObjectStorageSize`, `DisableSubdomainAccess`).
- **The provisioning document is the dangerous one.** `compileProvisioningYaml` forces
  `startWithoutCode: true`; applying it a second time wipes every runtime service's code. It belongs to
  first bring-up only.

**First application registration is collision-rejecting.** Its separate
`renderFabrikaProvisioningYaml` emission sets `override: false` on every service, while preserving
the canonical manifest's `override: true`. Registration waits for the reported import processes
before returning the service. Steady-state registration emits the canonical import.

On 2026-09-28, an explicit `override: false` import against an existing stopped probe returned
`400 serviceStackNameUnavailable`. A mixed document listing a new service before that existing
service also failed: the new service was absent afterwards, and the existing service stayed stopped.
An `override: true` codeless re-import, in contrast, returned a new `stack.deploy` process.
These are manual observations of those payloads, not a general transaction guarantee for all import failures.

#### Autoscaling profiles — what a managed service gets when you say nothing

`zops api GetClientSettingsStackType --param id=@client --param stackTypeId=postgresql` returns each
version's profile list with an `isDefault` flag and the resource envelope each one applies.
`zops api GetServiceStack --param id=<id>` reads back `autoscalingProfileId` and `currentAutoscaling`.

| Service                                       | Applied profile                     | Floor per container | CPU mode      |
| --------------------------------------------- | ----------------------------------- | ------------------- | ------------- |
| `postgresql:ha@18`, no `profile` written      | **`oltp-production`** (`isDefault`) | 2 cores / 4 GB      | **DEDICATED** |
| `postgresql:ha@18`, `profile: oltp-staging`   | `oltp-staging`                      | 1 core / 1 GB       | SHARED        |
| `postgresql:single@18`, no `profile`          | **`oltp-staging`** (`isDefault`)    | 1 core / 1 GB       | SHARED        |
| `postgresql:single@18`, `profile: oltp-hobby` | `oltp-hobby`                        | 1 core / 0.25 GB    | SHARED        |
| `alpine/bun@1.3` runtime                      | none (runtimes carry no profile)    | 1 core / 0.125 GB   | SHARED        |

Every profile shares the same ceiling — 8 cores / 48 GB / 250 GB — so a profile chooses the FLOOR and
the PostgreSQL tuning preset, not the cap. An explicit `profile` in an import document is honoured and
reads straight back (`wu2db` → `oltp-hobby`); the live `db` service, created with none, reads back
`oltp-staging`. `oltp-enterprise` is HA-only and `oltp-hobby` is single-only, matching the allowlists
in `provider-zerops/src/namespace.ts`.

**What a stock installation costs before an application is deployed.** The `standard` tier declares two
HA PostgreSQL services, i.e. **six database containers**. Left to the default that is 12 dedicated
cores and 24 GB at idle. Fabrika now states both profiles: `db` keeps `oltp-production` (identity and
control-plane latency is felt by every request), `operationsdb` takes `oltp-staging` (same redundancy,
same ceiling, a 1-core/1-GB shared floor — error history is bursty and tolerant of jitter), which
halves the idle floor of the data plane. The `light` tier is two `postgresql:single@18` services at
`oltp-hobby` — `db` for IAM and control, `operationsdb` for Operations, each a 1-core / 0.25 GB shared
floor with the same ceiling. A light installation created before Operations had its own database keeps
all three in `db`: an upgrade does not create a service
([ADR-0038](../decisions/0038-size-namespaces-cheaply-by-default.md)).

#### Probe durations: the published schema is wrong, and the platform bounds them

Reproduced with `zops validate <file> --project fabrika-test --service <svc> --operation DEPLOY`,
which calls `POST /service-stack/zerops-yaml-validation` — the same check the deploy runs.

| Behaviour                                                            | Result                                                                                         |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| The published `zerops.yaml` JSON schema's type for all six durations | **`integer`** — in the vendored copy AND in `GetZeropsYamlJsonSchema` fetched today            |
| Sending an integer                                                   | **Refused.** `yamlValidationInvalidYaml`, `cannot unmarshal !!int into time.Duration`          |
| Sending a Go duration string (`30s`)                                 | Accepted                                                                                       |
| Any of the six outside **[10s, 1h]**                                 | **Refused.** `invalid execPeriod <10s, 1h0m0s>` — `5s` and `2h` both fail, `10s` and `1h` pass |

The six are `deploy.readinessCheck.{failureTimeout,retryPeriod}` and
`run.healthCheck.{failureTimeout,disconnectTimeout,recoveryTimeout,execPeriod}`.
The installation's static schemas declare these fields as strings; generated-artifact tests enforce
the observed `[10s, 1h]` interval. The separately invoked
`packages/platform-artifacts/schemas/check.ts` compares both pinned upstream documents
without modifying them and distinguishes drift from unavailable responses.
`provider-zerops/src/types.ts` retains the matching `ZeropsDuration` type.

#### A deploy is genuinely gated by `deploy.readinessCheck`

A throwaway `alpine/bun@1.3` service was deployed twice with `zops deploy wu2app ./server.ts
--zerops-yaml ./zerops.yaml --project fabrika-test`, identical but for whether `/ready` answered 200.

| Deploy                     | App-version status  | Previously active version |
| -------------------------- | ------------------- | ------------------------- |
| readiness path answers 200 | `ACTIVE`            | → `BACKUP`                |
| readiness path answers 503 | **`DEPLOY_FAILED`** | **stays `ACTIVE`**        |

The failing container started cleanly, connected to Postgres and served `/healthz` with 200 throughout;
only `/ready` was 503, and that alone failed the deploy about 70s after container start with
`failureTimeout: 60s`. `run.healthCheck` is a different mechanism and gates nothing at deploy time.

#### Verified live (2026-10-16) — an exec readiness check and a failed init command each stop an activation

Measured by the platform-facts table's live suite (`live: 'build'`, `FABRIKA_LIVE_ZEROPS_SLOW=1`) on its throwaway
`alpine/bun@1.3` service. Each probe deployed a version whose descriptor fails one thing and nothing else.

| Behaviour                                                                                             | Result              | Row                                    |
| ----------------------------------------------------------------------------------------------------- | ------------------- | -------------------------------------- |
| A `deploy.readinessCheck` with an `exec` command `exit 1` (`retryPeriod: 10s`, `failureTimeout: 60s`) | **`DEPLOY_FAILED`** | `exec-readiness-gates-a-deploy`        |
| A `run.initCommands` entry `exit 1`                                                                   | **`DEPLOY_FAILED`** | `failed-init-command-stops-activation` |

The generated run section of a contract application
([ADR-0043](../decisions/0043-validate-and-render-one-zerops-descriptor-meaning.md)) depends on the second row: its
migrations, its schema check and its generated isolation tests are init commands. Its readiness check is the `httpGet`
above, against the contract's health endpoint.

#### Verified live (2026-10-21, account Contember, project `fabrika-live`): the readiness window opens with `run.start`, after the init commands

Measured by the platform-facts row `slow-init-command-precedes-the-readiness-window` (`live: 'build'`,
`FABRIKA_LIVE_ZEROPS_SLOW=1`) on its throwaway `alpine/bun@1.3` service: a version whose init command is `sleep 240`,
behind an `httpGet` readiness check with `retryPeriod: 10s` and `failureTimeout: 60s`, settles **`ACTIVE`**. The init
commands do not count against the readiness window, and an init command may run at least 240 s. No upper limit on an
init command's duration is known.

The Schrack CRM's runtime log (`intake/prod`, run `01a15ec9`) shows the same: the init commands ran 14:12:04–14:12:21,
Zerops logged `Readiness check: failureTimeout 3m0s`, and the first of 18 readiness attempts came at 14:12:22.

#### The PostgreSQL connection target

Read with `zops env show --service <svc> --json`, on a service deliberately NOT named `db`.

> **The TLS rows below are true of the service they were measured on and DO NOT generalise.** The
> `@18` service types behave differently — see
> [the 2026-08-19 section](#verified-live-2026-08-19-account-prg1-project-fabrika-notes-prod--postgresql-tls-is-per-service-type),
> which is what fabrika's canonical DSN now follows.

| Fact                                                        | Result                                                                                                         |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| The stored `connectionString`                               | The literal template `postgresql://${user}:${password}@${hostname}:${port}` — **no database path**             |
| `connectionTlsString`                                       | The same with `${portTls}`                                                                                     |
| `dbName` and `user` on a service named `wu2db`              | **Both `db`.** They do not follow the hostname — every PostgreSQL service names its database and its user `db` |
| `port` / `portTls`                                          | `5432` / `6432`                                                                                                |
| `sslmode=disable` on 5432                                   | Connects. `pg_stat_ssl.ssl = false`                                                                            |
| **`sslmode=require` on 5432**                               | **Connects, `pg_stat_ssl.ssl = true`** — 5432 speaks TLS, contrary to the published documentation              |
| `sslmode=verify-full` on 5432                               | **Fails**: `self signed certificate`                                                                           |
| `pg_settings.ssl` server-side on 5432                       | `on`                                                                                                           |
| `${a_connectionString}` referenced from a DIFFERENT service | Resolves, under `envIsolation: service` — explicit cross-service references are unaffected                     |

Without the database path the driver falls back to the USER name — which lands on the right database
only because the platform always names both `db`, a convention no document states. And `require` is the
strongest TLS mode available: it encrypts, and `verify-full` cannot work without Zerops' CA.

The PORT half of this was later measured to be service-type-specific, and the canonical DSN moved to
`portTls` — see below.

### Verified live (2026-08-05, account `prg1`, project `fabrika-test`) — public subdomain access

Produced on **throwaway services created and deleted for the purpose** (`wu3app`, `wu3b`); no platform
service was touched. The apply is `zops api ImportServiceStack --param id=@project --project fabrika-test
--body-file <doc>`, the enable/disable are `zops api {Enable,Disable}SubdomainAccess --param id=<service>`,
and the state is read with `zops api GetServiceStack --param id=<service>`.

#### An import document cannot establish a subdomain — not even on a service it creates

| Behaviour                                                                             | Result                                                                                              |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `enableSubdomainAccess: true` in an import that CREATES the service                   | **Accepted and silently dropped.** The new service reads back `subdomainAccess: false`              |
| The same document re-applied with `override: true` after the service has an HTTP port | **No-op.** No process, flag unchanged — the `override` semantics of the section above               |
| The flag after that service's FIRST successful deploy                                 | **Still `false`.** It is not stored and applied later; it is gone                                   |
| `PUT /service-stack/{id}/enable-subdomain-access` before any deploy                   | **400 `serviceStackIsNotHttp`**, "Service stack is not http or https"                               |
| The same call once the service publishes a deployed HTTP port                         | Works. Process `stack.enableSubdomainAccess`, `FINISHED` in **0.7 s**                               |
| Reading `subdomainAccess` back straight after that call                               | **Sometimes still `false`.** One run needed a second read 3 s later; another was `true` immediately |
| The same call on a service that ALREADY has a subdomain                               | **2xx, and the process it returns then FAILS** (70 ms, no reason in `publicMeta`)                   |
| Time from a successful enable to a 200 on the subdomain                               | **~3 s**, through the project L7 balancer (`nginx`, HTTP/2, valid TLS)                              |
| `subdomainAccess: true` across a later deploy of the same service                     | **Survives**, and the generated host does not change                                                |
| `DisableSubdomainAccess`, then a request to the host                                  | **502** from the balancer within seconds; re-enabling brings the SAME host back                     |

So **the only thing that establishes a `.zerops.app` entry point is
`PUT /service-stack/{id}/enable-subdomain-access` on a service that already publishes an HTTP port.** This
collides with ADR-0004's bring-up order by construction — provisioning imports every service
`startWithoutCode: true`, so at import time nothing has a port — which is why the call belongs after the
first deploy and not beside the import.

Two consequences the client shape depends on:

- **A 2xx from the enable is not a success signal.** The already-published case answers 2xx and fails the
  process it hands back, and the freshly-enabled case can still read `false` on the next read. The only
  sound decision procedure is: read `subdomainAccess`, act only if it is `false`, then read it back until
  it is `true` — which is what `ensureSubdomainAccess` in `@fabrika/provider-zerops` does.
- **A declaration that cannot be delivered must say so.** fabrika still writes `enableSubdomainAccess` in
  its import documents, because it is what ADR-0022's `assertOnlyPublicService` reads to prove no service
  other than the proxy is claimed public — but the generated artifacts' header now states that applying
  the file publishes nothing, and names the call that does.

#### `zeropsSubdomain` is a NAME, not a state

`GET /service-stack/{id}/env` returns a `zeropsSubdomain` variable — `type: SYSTEM`, corrected from
`READ_ONLY` on 2026-08-21 — once the service has deployed something. It is not evidence that a subdomain is
live:

| Behaviour                                                        | Result                                                                                |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `zeropsSubdomain` on a service whose subdomain was NEVER enabled | **Present and non-empty** — a full URL, on live `notesapi` (`subdomainAccess: false`) |
| `zeropsSubdomain` after `DisableSubdomainAccess`                 | **Unchanged.** Same value, while the host answers 502                                 |
| `zeropsSubdomain` on a service with several HTTP ports           | **Newline-separated, one URL per HTTP port** — six lines on the live `proxy`          |
| The host form                                                    | `<hostname>-<4 chars>-<port>.<region>.zerops.app`                                     |

Read the service's `subdomainAccess` to know whether a subdomain is live, and `zeropsSubdomain` only to
learn what it is called.

#### Verified live (2026-10-16) — the balancer forwards `Authorization` unchanged

A connector's consumer calls the owner's public proxy over HTTPS with `Authorization: Bearer <connector key>`
([application runtime](application-runtime.md#connectors)). That works only if the project L7 balancer passes the header
through unchanged. Measured by the platform-facts table's live suite (`live: 'build'`, `FABRIKA_LIVE_ZEROPS_SLOW=1`):
it deploys an echo server on the throwaway service, enables its subdomain, and sends one request from outside the
project with a random marker as the bearer.

| Behaviour                                                         | Result                                   | Row                               |
| ----------------------------------------------------------------- | ---------------------------------------- | --------------------------------- |
| A request to the subdomain with `Authorization: Bearer <a value>` | **200**, the echo is that value verbatim | `balancer-forwards-authorization` |

### Verified live (2026-08-08, account `prg1`, throwaway project `fabrika-wu1-probe`) — a proxy before it fronts anything

Measured to settle whether a Zerops installation can be brought up from an empty project. One `alpine@3.21`
service named `proxy`, imported with `startWithoutCode: true`, then built from the public repository.

| Behaviour                                                                 | Result                                                                                      |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `zeropsSubdomain` **before any deploy**                                   | **Present**, a single line with **no port segment**: `https://proxy-2b16.prg1.zerops.app`   |
| …but only once SOMETHING has deployed (corrected 2026-08-21)              | On a service imported WITHOUT `startWithoutCode` the key is **absent from `/env` entirely** |
| The same variable **after** a deploy publishing six HTTP ports            | Six lines, `https://proxy-2b16-<port>...`, one per port                                     |
| The `<4 chars>` segment across that transition                            | **Unchanged** (`2b16` before and after)                                                     |
| Lag between the version reaching `ACTIVE` and the six lines appearing     | **None measurable** — both were true in the same 10 s poll                                  |
| `POST /service-stack/{id}/user-data` on a service that has never deployed | **Works**, immediately after the import's processes report `FINISHED`                       |
| Service fields `zeropsSubdomain` / `ports` before a deploy                | **Absent** and `[]` — the subdomain is a generated ENV VARIABLE, never a service field      |
| The variable's `type` (corrected 2026-08-21)                              | **`SYSTEM`**, not the `READ_ONLY` this section first recorded                               |
| `enableSubdomainAccess` on a freshly deployed service                     | `subdomainAccess` read back `true` within 5 s                                               |

**A proxy carrying `FABRIKA_PROXY_MANIFEST_JSON={"apps":[]}` is a complete, deployable service.** It built
in ~190 s, deployed in ~60 s, reached `ACTIVE`, and answered **404** on public listener 8080 — which is
exactly what `zerops/setups.ts:409` claims an empty app list produces. This is what makes a two-pass
bring-up possible: pass 1 publishes the ports, pass 2 reads the per-port names and writes the real manifest.

Two limits on the above. The port segment is **predictable in hindsight** (`proxy-2b16` + `-<port>`), but
that is one observation of one format, and `derivePlatformHosts` still refuses to compose a hostname rather
than read one. And this run gave the proxy a legal `FABRIKA_IAM_ISSUER`/`FABRIKA_IAM_KEY`, so it does **not**
establish what happens when the auth binary cannot boot — a bring-up writes a legal pair, so the case does
not arise.

### Verified live (2026-08-10, account `prg1`, project `fabrika-install-test`) — a services-only import into an operator-created project

Measured by applying the committed `platform-light.services.provision.zerops-import.yaml` — a document
with **no `project:` block** — to a project created EMPTY by hand
(`1pNsLftARwS3N2RM0yxDvA`).

| Behaviour                                                                  | Result                                                                                    |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `POST /project/{id}/service-stack/import` with a services-only document    | **Works.** All six services created. This is the right endpoint for an operator's project |
| Processes returned, per service                                            | **1** for each managed service (`db`, `storage`), **2** for each runtime one              |
| The four runtime services immediately after the call returns               | **`status: NEW`, ZERO environment keys** — not even the platform's own generated ones     |
| Order and pace of creation                                                 | **Sequential, in the document's `priority` order, ~15 s apart**                           |
| When a service gains its ten generated keys (`zeropsSubdomain` among them) | **Once it leaves `NEW`** (first read at `CREATING`)                                       |
| Whole light topology from import to all six `ACTIVE`                       | **~61 s**                                                                                 |

Measured, one line per 15 s poll (`status/env-key-count`, `+sub` = `zeropsSubdomain` present):

```
+0s   db=ACTIVE/15  storage=ACTIVE/10  iam=CREATING/10+sub  operations=NEW/0        control=NEW/0            proxy=NEW/0
+15s  …             …                  iam=ACTIVE/10+sub    operations=CREATING/10+sub  control=NEW/0        proxy=NEW/0
+31s  …             …                  …                    …                       control=CREATING/10+sub  proxy=NEW/0
+46s  …             …                  …                    …                       …                        proxy=CREATING/10+sub
+61s  db=ACTIVE/15  storage=ACTIVE/10  iam=ACTIVE/10+sub    operations=ACTIVE/10+sub    control=ACTIVE/10+sub    proxy=ACTIVE/10+sub
```

Consequences, and they are ordering rules rather than facts about a field:

- **`importServices` returning is not "the services are usable".** A caller must wait on every process
  id the import handed back before it reads OR writes anything — a read of `zeropsSubdomain` before that
  comes back empty, and `POST /service-stack/{id}/user-data` has nothing to attach to. Wait on the
  processes; do not sleep on a number the platform never promised. Budget ~15 s per runtime service and
  leave the attempt bound comfortably larger.
- **This narrows WU1's `zeropsSubdomain` finding rather than contradicting it.** The variable really is
  present before any deploy — but only once the service has left `NEW`. Both facts hold; their order is
  what a bring-up depends on.
- **A service still reading `NEW` cannot be adopted by a later run**, which holds no process ids for it.
  `platform install` refuses rather than sleeping, and says to run it again shortly.

A project created through `POST /client/{id}/project/import` (measured 2026-08-21) reads `mode: LIGHT`
at once and moves `NEW → CREATING → ACTIVE` in about 20 s. Whether a service import into a `CREATING`
project succeeds has not been measured.

### Verified live (2026-08-11, account `prg1`, project `fabrika-install-test`) — where a build source lives

Measured on a throwaway `alpine/bun@1.3` service (`wu1probe`), since deleted, against the public
`contember/fabrika-platform`.

| Behaviour                                                                                     | Result                                                                                          |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| An import whose service declares `buildFromGit`                                               | **Starts a build by itself** — the response carries a second process, `actionName: stack.build` |
| What the resulting app version records                                                        | `publicGitSource: {gitUrl, branchName: "main", configContentFromImport: false, explicitSetup}`  |
| `PUT /service-stack/{id}/trigger-pipeline` with **no** `buildFromGit`                         | **Refused**, both before and after a successful build from that source                          |
| The same call **with** `buildFromGit`                                                         | Accepted; the version built and moved on to deploy                                              |
| Branch, when the URL names none                                                               | **`main`**, chosen by the platform                                                              |
| App-version create → presigned upload → `build-and-deploy`, using a project integration token | **Accepted**; Zerops unpacked the uploaded repository root and completed its build              |

**A public build source is a property of an app VERSION, never of the service.** Nothing durable is
configured by handing one to an import or to a trigger — so **every** deploy must supply it again.
Zerops also offers a durable user-scoped repository integration, but the Fabrika installation token
cannot consume that user's OAuth grant. Fabrika's unattended private-source path therefore creates an
app version and uploads source through the operator-owned GitHub App described by ADR-0029 and proven
by the archived
[application deploy sprint](../archive/sprint-2026-08-11-fabrika-deploys-an-app-on-zerops.md).

Two smaller things, both worth knowing before debugging one:

- **The refusal names nothing.** A trigger with no source answered `Service stack not found` for an
  empty body and `Invalid parameter provided` when only `zeropsSetup` was set — two different errors
  for the same missing input, neither mentioning a build source, on a service id that the very next
  call accepted.
- **A `stack.build` that fails before it creates a container leaves its app version at
  `WAITING_TO_BUILD` permanently.** The process was `FAILED` 500 ms in and carried no message; the
  version had not moved eight minutes later. Fabrika now watches both objects and fails immediately
  when the process fails; the live witness is in the archived
  [application deploy sprint](../archive/sprint-2026-08-11-fabrika-deploys-an-app-on-zerops.md).

The upload row was measured on 2026-08-11 with the exact project-scoped integration token installed on
`control`, against disposable service `wu3uploadprobe` in `fabrika-install-test` (deleted afterwards).
The uploaded standalone example was 24.9 KiB compressed / 71.7 KiB extracted. Zerops completed
`bun install --frozen-lockfile`, prepared a 47.3 MiB deploy artifact and uploaded 9.6 MiB of it. The app
version recorded `source: CLI` and no `publicGitSource` or GitHub integration. Its runtime deploy then
failed as expected because the probe had no application database or environment; the completed build
is the witness relevant to source transport.

A second disposable app-version probe measured the credential-bearing destination without recording
its query: HTTPS, host `proxy.app-prg1.zerops.io`, no explicit port, exact path
`/api/rest/object-storage/upload`, empty username and password, a non-empty query, and no fragment. The
service `wu3urlprobe` was deleted afterwards. A source transporter can therefore reject every other
origin or path before it reads repository bytes and can refuse redirects instead of forwarding a
presigned upload credential.

A third disposable service (`wu3stateprobe`) tested the pre-trigger recovery boundary. A new app
version reported `UPLOADING`; after a successful archive PUT it still reported `UPLOADING` even after
the request had returned. `deleteAppVersion` then returned `{ success: true }` and the version was no
longer readable. The same delete also removed a second version that had received no upload. The
version status cannot tell an uploaded version from an empty one, but the project integration token
can delete either; ADR-0044's delete-before-trigger recovery relies on that. The service was deleted.

### Verified live (2026-10-02, account `prg1`) — an uploaded archive keeps its committed bytes

Fabrika uploads every source as an archive ([`provider-bundles.md`](provider-bundles.md#zerops-source-transport)).
Two disposable probes measured what Zerops builds from such an upload.

**Live source transport/extraction witness, 2026-10-02.** The production repository/archive,
gzip and native PUT pipeline uploaded public commit `9917992ad1a0a462e060064255d9a90a3a2ed968` to reserved version
`2DrJGgXaT3Gt7zY0R9RDaw`. Both HTTP 200 and archive validation completed before build process
`KsxeStQVQGy7jhLWwu8LXw` was submitted; the process finished successfully. An explicit small probe
descriptor, SHA-256 `e5d0fdbf1aa1b9a5013b81dc468b73b537a8e284e81f3ff7bc9e22599f11d190`, selected
`package.json` and the two link/target pairs for deployment. The runtime returned the fresh nonce
`ba0e23f2-5f30-4292-bfc1-93f0e00eef17` and package hash
`50b56ac7caa1fc92e11529d1d655221c3c84f519c4d532aeb00b4e56215b205c`, matching the pinned Git blob.
Both links remained symbolic links to `CLAUDE.md`; their contents and adjacent targets matched the
pinned blobs. Stop process `32ylCqGBQiuPRKtomiy1oQ` finished and the service was read back `STOPPED`.
This proves transport, extraction and selected source bytes. The submitted descriptor was the probe,
not the repository's platform descriptor, so it does not establish full platform installation acceptance.

**Native committed-archive witness, 2026-10-02.** The installation snapshot and native PUT helpers
uploaded commit `3572422d78fa07a91c4496b2aba6ba31036adcd7` from a disposable fixture. Version
`gO1pAdXHR0SVZu6QUv84pw`, built by process `iQ37tvRGSUOXh0oxIu3XbQ`, served the fixture payload
with SHA-256 `0cd1e2e47908bb56d4b5ce7794a1f7ae5f187294cfd50a233b94fc74e4ec102b`, matching its
committed blob. LF and literal `$Id$` survived committed `eol=crlf ident` attributes. The running
process reported the relative alias as a symlink and read identical bytes through it. The build used
the canonical descriptor renderer; original descriptor SHA-256 was
`d8edc666b38188799ed6e29a2025dff8b7b7d4a61e49a10a90a5b870c6153650`. The probe was stopped afterwards.
This proves the tested native archive/upload/extraction path, not full installation or upgrade acceptance.

### Verified live (2026-08-21, account `prg1`) — a streamed upload fits a 128 MB container

Measured 2026-08-21 on the test installation, when the same streamed pipe ran in a separate service at
its `0.125 GB` floor (read once a second through `GET /service-stack/{id}/container` →
`currentHardwareResource`, the allocation vertical autoscaling raises when a container needs more): a
250 MB incompressible repository (25 × 10 MB random files beside the 62 MB example app) deployed in
3 min 22 s with the tarball stream taking about 17 s, and the example app alone in 3 min 08 s — the
service stayed at **one container × 128 MB** for both.

### Verified live (2026-08-18, account `prg1`, projects `fabrika-install-test` + `fabrika-notes-prod`) — provisioning an app namespace

The first namespace ever provisioned on a real account. Three platform facts, each measured rather
than read, and each of which stopped the provision dead until it was addressed.

| Behaviour                                                                                                              | Result                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /client/{id}/project/import` with the installation's integration token (client `NO_ACCESS`, one project `ADMIN`) | **`403 insufficientPermissions`.** Client-scoped READS with the same token answer `200`, so the token is healthy — it simply may not create a project ([ADR-0034](../decisions/0034-the-control-plane-creates-the-projects-it-owns.md)) |
| The same call after `zops token integration update <id> --can-create-projects`                                         | **Accepted.** The token's grant list gains the new project at `OWNER`, automatically and without being asked                                                                                                                            |
| `POST /service-stack/{id}/user-data` without `sensitive`                                                               | **`400 invalidUserInput`**, `meta.metadata = {"sensitive":["field is required"]}`. The same applies to `PUT /user-data/{id}` — **SUPERSEDED, see 2026-10-15 below**                                                                     |
| A user-data write with `sensitive: true`                                                                               | Accepted, and `GET /service-stack/{id}/env` still returns its `content` VERBATIM — **SUPERSEDED, see 2026-10-15 below**                                                                                                                 |
| `enableSubdomainAccess` immediately after the namespace proxy's first build reports ACTIVE                             | **`serviceStackIsNotHttp`** — "exposes no deployed HTTP port". The ports appear a moment later; the next reconcile succeeds                                                                                                             |

The last one is worth stating plainly, because it contradicts the natural reading of the
`enableSubdomainAccess`-after-first-deploy rule recorded above: an ACTIVE app version is not yet
sufficient. The published HTTP ports lag it, so a namespace provision must tolerate one retry rather
than treat the error as terminal.

Seen again on 2026-10-15, on a fresh light-tier installation following the operator guide: the namespace
proxy's version read `ACTIVE`, the enable answered `serviceStackIsNotHttp`, and `control namespaces
reconcile` about a minute later published it. So both the namespace lifecycle and `platform deploy` send the
enable through `enableSubdomainAccessWhenHttp` (`packages/provider-zerops/src/api/polling.ts`), which asks
again every 5 s for about 3 minutes while the answer is `serviceStackIsNotHttp`, and only then fails.

Grants are fixed at mint time and the update API replaces the grant set WHOLESALE, so an operator
repairing a live token must re-pass every existing project grant in the same call or silently remove
it.

### Verified live (2026-08-21, account `prg1`, project `fabrika-test2`) — an integration token can read its own capabilities

| Call, authenticated with the installation's INTEGRATION token (client role `NO_ACCESS`)   | Result                                                                                                   |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `GET /user/info` (`GetUserInfo`)                                                          | **200.** `id` is the token's own id; `fullName` is the token's name; `clientUserList[]` names the client |
| `GET /client/{clientId}/integration-token/{tokenId}` (`getIntegrationToken`) with that id | **200.** Carries `canCreateProjects`, `roleCode` and the `projects[]` grants                             |
| `GET /client/{clientId}/integration-token/list` (`listIntegrationTokens`)                 | **200** — the token reads EVERY integration token of the client, not only its own                        |

So a control plane CAN learn, before it mutates anything, whether its token may create projects: two
reads, no guessing. The third row is a platform fact worth knowing: an integration token is not
confined to its own record.

The mint itself (`POST /client/{id}/integration-token`) was verified on 2026-08-07: the platform
accepts client role `NO_ACCESS` beside a per-project `ADMIN` grant.

Reported by an operator at `v0.4.2` (not measured here): authenticated with an integration token, that
mint answers `403 notAllowedForIntegrationTokenWithoutDelegation`, and `GET /user/info` returns
`email: token-<id>@zerops.io`. `platform install` therefore reads `/user/info` before it creates anything
and refuses that identity (`packages/provider-zerops/src/installation/install-token.ts`).

Also measured the same day: `zops env set … --sensitive` on an EXISTING sensitive variable is refused
with `sensitive: field is required` (the CLI's update body omits it); the raw `PUT /user-data/{id}`
(`UpdateUserDataById`) with `{ key, content, sensitive: true }` is accepted and returns a
`stack.updateUserData` process. A token swapped that way is read by the service only after
`service restart`.

### Verified live (2026-10-15, account `prg1`, a disposable project) — a sensitive value is `REDACTED` outside sudo mode

| Call                                                                                          | Result                                                                                         |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `GET /service-stack/{id}/env` with an integration token (`sudo: false`), sensitive record     | **`content: "REDACTED"`**, `sensitive: true`. A non-sensitive record reads back verbatim       |
| The same with a personal token whose user is in sudo mode (`GET /auth/sudo` → `inSudo: true`) | The value itself                                                                               |
| `GET /user-data/{id}/reveal` with that integration token                                      | **`notInSudoMode`** — "Re-authentication via password or any 2FA method is required"           |
| `PUT /user-data/{id}` with `{ key, content, sensitive: false }` on a sensitive record         | Accepted with the integration token; the record then reads back verbatim as `sensitive: false` |
| `PUT /user-data/{id}` without `sensitive`                                                     | **200**, and a sensitive record becomes `sensitive: false`, readable                           |
| `POST /service-stack/{id}/user-data` without `sensitive`                                      | **200**, a `stack.updateUserData` process; the record is created `sensitive: false`, readable  |

Sudo mode belongs to a user session (password or 2FA re-authentication, or a token minted with `sudo: true`),
so the same call reads a secret on one machine and `REDACTED` on another. Fabrika depends on neither: the
client drops a sensitive record's `content` at the boundary (`api/service-env-response.ts`), every write
states `sensitive` per key (a write without it stores the value readable, so the client's write type requires it and
`api.test.ts` pins it in every body), credentials are written sensitive and never compared, and everything a deploy
compares or merges is written readable. `platform install` writes the operator's copy of every credential it
creates to `--secrets-file` before placing the first one.

Releases up to 0.4.2 wrote every variable sensitive, the platform proxy's `FABRIKA_PROXY_MANIFEST_JSON` included.
`platform deploy` rewrites each value it owns readable, and deletes that manifest copy unread
(`DELETE /user-data/{id}`), because nothing reads it any more.

Measured live 2026-10-15 with an installation's integration token (not in sudo mode), on a runtime service of a real
project: `POST /service-stack/{id}/user-data` with `sensitive: true` answered 200; `GET /service-stack/{id}/env` read
the record as `sensitive: true`, content `REDACTED`; `DELETE /user-data/{id}` answered 200; a re-read listed no record
of that key. **Deleting a sensitive variable needs no sudo mode.**

### Verified live (2026-10-15, account `prg1`) — a service variable value over ~32 KB is a bare 500

Source: the measurement in [issue #3](https://github.com/contember/fabrika-platform/issues/3), a throwaway
sensitive variable on a runtime service, written through the env API and deleted again. It was not re-measured
for this document; the `user-data-value-*` rows of the platform-facts table re-check it in the live suite.

| Value length (ASCII bytes)                 | Result                                                     |
| ------------------------------------------ | ---------------------------------------------------------- |
| 8,000 / 16,000 / 32,000                    | Created                                                    |
| 32,768 / 32,769 / 33,000 / 40,000 / 65,000 | **`500 Internal Server Error`**, no error code, no message |

The limit lies between 32,000 and 32,768 bytes; the sizes between were not probed, and neither was a value
with multi-byte characters. The platform reports it as an internal error, not as a validation error, so it
reads as an outage. The client refuses a value over `ZEROPS_SERVICE_ENV_VALUE_MAX_BYTES` (32,000 UTF-8 bytes,
`api/service-env-limit.ts`) before it sends the write, with an error that names the variable, its size and the
limit, never the value; a namespace lifecycle classifies it `serviceEnvValueTooLarge`, not retryable. The
proxy manifest, which carries every endpoint table a proxy fronts, therefore travels as a file in the proxy's
build archive ([ADR-0045](../decisions/0045-upload-immutable-platform-and-namespace-proxy-sources.md)); only a
namespace pinned to a release whose proxy build lifts `FABRIKA_PROXY_MANIFEST_JSON` still gets the variable,
and the limit, until it is re-pinned with `fabrika control namespaces update --proxy-source=current`.

### Verified live (2026-08-21, account `prg1`, project `apps-test2`) — a missing service by name is a 400

The first registration into a freshly provisioned namespace — one that holds only the proxy and the
database, so the app's own service does not exist yet — answered `502 provider registration preparation
failed`. The look-up that should have said "absent" had thrown instead.

| Call                                                                  | Result                                                                                                                                |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /service-stack-by-name/{projectId}/{hostname}`, hostname present | **200**, the service record                                                                                                           |
| `GET /service-stack-by-name/{projectId}/{hostname}`, hostname absent  | **`400 serviceStackNotFound`** — "Service stack not found." — on the namespace project and on the platform project alike, never a 404 |

The same code the `user-data` LIST returns on every service (see 2026-08-03 above), here meaning what it
says. A client deciding "present or absent" by HTTP status treats an absent service as a failure; the
decision has to read the error code. The local emulator answers the same 400 since the same day.

### Verified live (2026-08-21, account `prg1`, project `apps-test2`) — the unpacker needs directory entries

The first deploy through the streamed tarball path (ADR-0029) reached `BUILDING` and failed 45 s later
with no line after "DOWNLOADING APPLICATION SOURCE CODE … unpacking it on the container"; the
app-version and its process carried no reason. The same tree pushed with the CLI built and deployed.
Three hand uploads of the same 21 files through `POST /service-stack/{id}/app-version` → `PUT
uploadUrl` → `PUT /app-version/{id}/build-and-deploy` isolated the variable:

| Archive                                                                                                          | Result                                              |
| ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Regular files only (`0` entries), `Content-Length` upload                                                        | **`BUILD_FAILED`** at unpacking, no reason recorded |
| The same files preceded by one `5` entry per parent directory (`src/`, `src/__tests__/`), mode `0755`, mtime `0` | **`ACTIVE`**                                        |
| The rewrite with parent directories derived from file paths                                                      | **`ACTIVE`**                                        |

So the platform's unpacker does not create a missing parent directory on its own; an archive must name
every directory before the first file inside it. The CLI's archive does exactly that (directories first,
file mtime `0` like ours), so nothing else in the header differs. The streamed PUT without a
`Content-Length` was not the cause: the same flat archive failed with one.

### Verified live (2026-08-21, account `prg1`, a throwaway project since deleted) — deleting a service, and what an absent id answers

Measured while building the `platform-facts` suite, on one throwaway service created with
`startWithoutCode: true` and then removed.

| Call                                                           | Result                                                                                                                       |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `DELETE /service-stack/{id}`                                   | **200** with a PROCESS body — `{ id, status: PENDING, actionName: stack.delete, serviceStackId, projectId, … }`, not a `204` |
| That process, polled                                           | **`FINISHED` after about 21 s**                                                                                              |
| `GET /service-stack/{id}` afterwards                           | **400 `serviceStackNotFound`**                                                                                               |
| `GET /service-stack-by-name/{projectId}/{hostname}` afterwards | **400 `serviceStackNotFound`** — the same answer a name that never existed gets                                              |
| A second `DELETE /service-stack/{id}`                          | **400 `serviceStackNotFound`**                                                                                               |
| `GET /service-stack/{id}` for an id that never existed         | **400 `serviceStackNotFound`**                                                                                               |
| `GET /service-stack/{id}/user-data` for an absent id           | **400 `serviceStackNotFound`** — the same code that endpoint returns on every live service                                   |
| `POST /service-stack/{id}/user-data` for an absent id          | **400 `serviceStackNotFound`**                                                                                               |
| A SUCCESSFUL `POST /service-stack/{id}/user-data`              | **200**, not 201, with the `stack.updateUserData` process body                                                               |
| `DELETE /project/{id}`                                         | **200** with a `project.delete` process                                                                                      |

So the whole service-stack family says "absent" the same way — `400 serviceStackNotFound` — whether the
id never existed, the hostname never existed, or the service was deleted a moment ago. This extends the
by-name finding above rather than narrowing it: nothing in this family answers 404, so a client deciding
"present or absent" by HTTP status is wrong in every one of those cases.

A delete is asynchronous like every other service mutation: the 200 is the process starting, and only
that process reaching `FINISHED` means the service is gone. A read taken BETWEEN the two was not
measured, so the double removes the record at once and the suite reads only after the wait.

### Verified live (2026-08-21, account `prg1`, a throwaway project since deleted) — what the first automated run corrected

The first run of the `platform-facts` table against a real account failed four rows, and all four were
this document being out of date rather than the platform misbehaving. Measured on `alpine/bun@1.3`
services created and deleted for the purpose.

| Behaviour                                                                             | Result                                                                                                                    |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `GET /service-stack/{id}/user-data` on a live service, with code and without          | **200** `{ list: [{ id, created, lastUpdate, clientId, projectId, serviceStackId, key, content, type, … }], totalCount }` |
| The same call on an id no service has                                                 | **400 `serviceStackNotFound`** — unchanged, and now the ONLY condition that answers it                                    |
| `zeropsSubdomain` in `/env` on a service imported WITHOUT `startWithoutCode`          | **Absent.** Not empty — the key is not in the response at all, and the service reads `status: READY_TO_DEPLOY`            |
| `zeropsSubdomain` once a `startWithoutCode` service's EMPTY version has deployed      | **Present**, one line, no port segment, **`type: SYSTEM`** — the 2026-08-08 section called it `READ_ONLY`                 |
| An import whose service carries `startWithoutCode: true`                              | **Two processes**: `stack.create` and `stack.deploy` — the empty deploy that flag asks for                                |
| Re-applying that document with `override: true`, unchanged or with `maxContainers: 3` | **One `stack.deploy` every time.** A document carrying the flag is never a no-op                                          |
| An import whose service does NOT carry it                                             | **One process** (`stack.create`); the service then reads `READY_TO_DEPLOY`                                                |
| Re-applying THAT document, unchanged or with `maxContainers: 3`                       | **`processes: []`**, and the read-back `horizontalAutoscaling.maxContainerCount` stays at its default of 10               |

Three consequences, none of them cosmetic:

- **The user-data LIST endpoint is no longer a trap.** Two dated sections above record it answering
  `400 serviceStackNotFound` unconditionally; that is no longer true and they are marked superseded. The
  client is unchanged and still reads `GET /service-stack/{id}/env`: that is the endpoint whose record ids
  `PUT`/`DELETE /user-data/{id}` take, and this one's paging terms have never been verified. The bring-up
  ordering rule survives for its own reason — a create must work on a service that has never deployed.
- **`zeropsSubdomain` appears at the first DEPLOY, not at the import.** Every earlier measurement was taken
  on a `startWithoutCode` service, whose empty version deploys as part of the import, which is why the
  variable looked like it was there "before any deploy". A reader must treat an absent key as "no name
  yet"; `derivePlatformHosts` already refuses to compose a hostname rather than read one.
- **A fabrika re-import is never a no-op.** Every provisioning document fabrika emits carries
  `startWithoutCode`, so every reconcile re-activates an empty version. The `override` section's two no-op
  rows describe documents without the flag.

### Verified live (2026-08-19, account `prg1`, project `fabrika-notes-prod`) — a user-data write is an asynchronous process

The first app deploy into a namespace failed at `build-and-deploy` with a bare `400`, deterministically
and eleven seconds in, while the same call issued by hand with the same token, the same descriptor and
the same uploaded archive answered `200`. The difference was the five environment variables the deploy
writes to the app's service immediately before it asks for the build.

| Behaviour                                                                             | Result                                                                                                                 |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `POST /service-stack/{id}/user-data`, `PUT /user-data/{id}`, `DELETE /user-data/{id}` | Each answers a **`PENDING` `stack.updateUserData` process**, not the record. `DELETE` answers a process too, not `204` |
| `PUT /app-version/{id}/build-and-deploy` while such a process is running              | **`400 userDataSyncRunning`** — "Process of synchronizing userData is already running"                                 |
| The same process, polled                                                              | `PENDING` → `RUNNING` → `FINISHED` in about **3 s**, on a deployed service and on a `startWithoutCode` one alike       |
| `PUT /app-version/{id}/build-and-deploy` with no user-data process running            | Accepted — with an uploaded archive, with an archive uploaded by hand, and with no upload at all                       |
| `GET /app-version/{id}` for an id that no longer exists                               | **`400`**, not `404` — so a bare 400 from this family says nothing about which condition was violated                  |

Two consequences. Every user-data write must be waited out before the next operation on that service,
which is why `putServiceEnv`, `createServiceEnv` and `deleteServiceEnv` now poll their own process
before returning. And an endpoint whose error CODE is dropped is undiagnosable: `build-and-deploy`
keeps its code from now on, because nothing in that request or response is a secret.

**Fresh creation provenance witness, 2026-10-02.** A collision-rejecting codeless import created
disposable service `9YWl1QygSmGeGnmKvYISDw`. The response's `serviceStacks` entry identified its
name and ID, and associated both processes with that same `serviceStackId`: creation
`LBlWJpvIS76eqUGUekKYsg` (`stack.create`) and initial empty deployment
`2iajEpXZSRG7t8kFOVjiBg` (`stack.deploy`). Polling each process returned the same ID, action and
service association with status `FINISHED`. This supplies positive creation evidence for that
specific import; service discovery alone does not. The disposable service was deleted afterwards.

**Deleted reservation absence witness, 2026-10-02.** A disposable reservation
`Dh42hIJ6SJW5psESpIlL9w` was deleted with `{ success: true }`. Subsequent GET and DELETE requests
for that same app-version ID both returned HTTP `400` with the exact `meta` code
`appVersionNotFound`. This identifies absence for pre-trigger cleanup recovery; an arbitrary `400`
or `404` does not. It does not establish that an ambiguously submitted build is safe to delete.

### Deleted-version upload race witness, 2026-10-03

Two disposable reservations on service `AdqxuK7UTk2rDAwMvqQCjQ` tested deletion before and during
upload. The original codeless active version was `fTIgjl3lSn6XxInSq9vIrA`.

| Observation                           | Delete before PUT        | Delete during held-open PUT |
| ------------------------------------- | ------------------------ | --------------------------- |
| Reserved version                      | `ry2VKjOsQgAZcMqpe8Vg7A` | `PSAQCKapS9GzCc2ycCUgqw`    |
| Initial status                        | `UPLOADING`              | `UPLOADING`                 |
| DELETE                                | `success: true`          | `success: true`             |
| Exact GET immediately after deletion  | `400 appVersionNotFound` | `400 appVersionNotFound`    |
| Original signed upload PUT completion | HTTP 200                 | HTTP 200                    |
| Exact GET after PUT                   | `400 appVersionNotFound` | `400 appVersionNotFound`    |
| Build request against deleted ID      | `400 appVersionNotFound` | `400 appVersionNotFound`    |

Both version lists retained only the original active version. Both process lists retained only the
two baseline creation/empty-deployment processes. The active version did not change. Exact GETs about
three seconds after the rejected build still reported absence.

The payload was a valid 131,275-byte tar.gz containing harmless random data. For the in-flight case,
the endpoint returned HTTP 100 Continue, then the client sent 65,536 body bytes and withheld the rest.
Linux TCP acknowledgement counters increased by 65,624 bytes before deletion. After confirmed deletion,
the client sent the remaining bytes and received HTTP 200. This proves remote TCP acknowledgement of
transmitted encrypted body bytes, not application-handler or backing-store consumption before deletion.

The observations support exact-version deletion as a pre-trigger activation barrier (ADR-0044).
They do not prove physical blob cleanup, upload-URL revocation, transport termination, indefinite
non-resurrection or safe deletion after ambiguous build submission. The probe used the existing
operator credential, not a separately tested project-scoped integration credential.

Cleanup process `okhd1eDPSvmVVgwTQc8RPw` finished; service GET then returned
`400 serviceStackNotFound`. Two earlier disposable setup attempts failed before version reservation
and were also deleted with absence confirmed. This is a manual witness, not automated live-test coverage.

**Managed bootstrap and sensitive-record witness, 2026-10-02.** On disposable service
`ePK3O6FASjWgkVVuldO4CQ`, the finished codeless deploy process `x3bqYIl6QlOx63xtHgi5sA` identified
version `EtWO40wqRyCHjLAzuBPJuw`. The service's nested `activeAppVersion` identified that same version
with status `ACTIVE` and source `NONE`; the raw response had no top-level `activeAppVersionId`.
After a create-only `user-data` write with `sensitive: true` and completed synchronization,
`GET /service-stack/{id}/env` returned the dummy record with **`type: USER`, `sensitive: true`**,
its exact ID and service association, and the intended content. The 63-character
`FABRIKA_MENV_<48 lowercase hex>_R` name was accepted. Record type `SECRET` is therefore not a valid
requirement for confirming these API-created sensitive values. The service was deleted afterwards.

### Verified live (2026-08-19, account `prg1`, project `fabrika-notes-prod`) — PostgreSQL TLS is per service type

The example app's first deploy into a namespace built and shipped, then failed its deploy gate in
`run.initCommands`: `PostgresError: Server does not support SSL (ERR_POSTGRES_TLS_NOT_AVAILABLE)`. The
DSN was the canonical form recorded above, and that form had been measured on a single-node service.

Measured from a throwaway `alpine/bun@1.3` service against one `postgresql:ha@18` and one
`postgresql:single@18` in the same project, both created and deleted for the purpose.

| Connection                          | `postgresql:ha@18`                                | `postgresql:single@18`     |
| ----------------------------------- | ------------------------------------------------- | -------------------------- |
| `port` (5432), `sslmode=disable`    | Connects, `pg_stat_ssl.ssl = false`               | Connects, `ssl = false`    |
| `port` (5432), `sslmode=require`    | **Fails: `Server does not support SSL`**          | Connects, **`ssl = true`** |
| `portTls` (6432), `sslmode=disable` | **Fails: `SSL required`**                         | **Fails: `SSL required`**  |
| `portTls` (6432), `sslmode=require` | **Connects**, backend `inet_server_port() = 5432` | **Connects**, `ssl = true` |

So `portTls` + `sslmode=require` is the ONE form that works on both for the service's own users, and it is what the
installation's `POSTGRES_URL` uses. It matters beyond the example — the installation's `standard` tier runs
`postgresql:ha@18` and would have failed the same way the first time anyone brought it up. An application's database
does not use it: pgBouncer on `portTls` refuses every role fabrika creates
([2026-10-15 below](#verified-live-2026-10-15-account-prg1--an-applications-database-roles-and-the-two-ports)).

On HA the TLS session terminates in front of PostgreSQL: the backend reports `pg_stat_ssl.ssl = false`
and `inet_server_port() = 5432` on a connection made to 6432. The hop from that terminator to the
database stays inside the service.

**`portTls` is not a transaction pool**, which is what the older note above assumed from the port
number. On both service types the same connection kept its backend pid across statements, kept a `SET
SESSION` value, and took and saw a session-level advisory lock — so the migration runner's lock is safe
there.

### Verified live (2026-09-23, account `prg1`) — service variables across activation and rollback

Measured on a disposable `envprobe` service (`alpine/bun@1.3.9`, one container) in a fresh `LIGHT`
project. The probe returned its hard-coded code version, process boot timestamp, `FABRIKA_RELEASE`
and `FABRIKA_OPERATIONS_DSN` over HTTP. Both variables contained dummy labels, never credentials.
Every env write waited for its `stack.updateUserData` process before the next operation.

| Operation                                                             | Stored service variables | Running process                              |
| --------------------------------------------------------------------- | ------------------------ | -------------------------------------------- |
| Set v1 values and successfully push code v1                           | v1                       | Code v1, values v1                           |
| Set v2 values without restarting                                      | v2                       | Code v1, values v1, unchanged boot timestamp |
| Push code v2 with `buildCommands: [exit 1]`                           | v2                       | Code v1, values v1, unchanged boot timestamp |
| Restart after that failed build                                       | v2                       | **Code v1, values v2**, new boot timestamp   |
| Set v3 values and successfully push code v3                           | v3                       | Code v3, values v3                           |
| Roll back to archived code v1                                         | v3                       | **Code v1, values v3**, new boot timestamp   |
| Set v4 values, push code v4 with `sleep 180`, cancel while `BUILDING` | v4                       | Code v1, values v3, unchanged boot timestamp |
| Restart after the version reaches `CANCELLED`                         | v4                       | **Code v1, values v4**, new boot timestamp   |

Rollback used `zops version rollback` with the explicit v1 id: `PUT /app-version/{id}/deploy`
with an empty body, completing as `stack.deploy.backup`. It did **not** restore service-API variables,
including to v2 (the values v1 used at its last restart). This measurement does not cover
`run.envVariables` or a different GUI restore operation.

The sequence used versions `uNHefI8HRYSBAp1agKGT3w` (v1), `NNReduBGQTa3OMAikUdAOg` (failed v2),
`wBQA9wZ7SdK6oHmyA9fbkw` (v3), and `dpkSuzAeSYeqa5qAvpQBAQ` (cancelled v4). The service was
stopped after observation. The fact table records these as manually verified, not automated probes:
the current suite does not observe a real application's process environment over HTTP.

**Service-API variables are mutable service state, not an atomic release binding.** A failed or
cancelled build leaves the values in place; a later restart exposes them to the old code. A successful
deploy or archived-version deploy also boots with the current values. This is why
[ADR-0044](../decisions/0044-zerops-delivery-ownership-and-recovery.md) binds only `FABRIKA_RELEASE`
to the version and accepts that the other managed keys follow current service state.

### Verified live (2026-09-23, account `prg1`) — version-selected environment references

A separate one-container Bun probe used immutable synthetic service values such as
`FABRIKA_SNAPSHOT_A_RELEASE`, referenced by canonical keys in `run.envVariables`.
Both init commands and the HTTP process reported the resolved values.

- Version A (`kReB9wcJRwK5tnHpBAZNbw`) used A values. Staging B values and failing B's build
  (`ooeLoEZjSwAITUMaBSn2BQ`) did not change A's values after a service restart.
- Successful B (`scye0w1iQ9uANPIUSnVgQw`) used B values. Its omitted optional descriptor key
  was absent in init and runtime. Explicit rollback to A restored A values and its optional key.
- On a legacy service, successful deployment of descriptor references replaced the canonical
  service records with those references. Rolling back to the pre-reference version left its
  canonical release and DSN absent. This is not a safe automatic legacy migration.

On September 28, a candidate using the retained B references was cancelled while `BUILDING`.
After process `dU75YOf9Ri6nBo4AvNcoFQ` reported `CANCELED` and version
`jFwUYGw4TtKsBlWR9g7SYw` reported `CANCELLED`, a service restart still ran code A with A values
in both init commands and the HTTP process. This covers cancellation during build, not a race with activation.

These observations cover one container, not concurrent reconciliation or Control crashes. They
establish the reference-selection primitive, not a complete activation protocol.

The native pipeline experiment used `envSecretsFile`. It changed service records even when its
build failed. An old process retained A values on the measured restart, but after a later successful
upload build, rollback to A used newer C values. Adding `envSecretsFile` to the upload endpoint's
`build-and-deploy` body did not apply the requested D values. That field is absent from the endpoint's
published schema. `trigger-pipeline` also created a separate GIT version rather than building the
reserved uploaded version. These fields do not establish an atomic upload-and-configuration binding.

### Verified live (2026-09-28, account `prg1`) — `buildFromGit` revision suffixes

The `@v0.0.26` suffix and the `@829753baf1ba04c8907b16c91d6f4db890e18e43` suffix on
`https://github.com/contember/fabrika-platform` did not select the requested source through
`trigger-pipeline`. The tag experiment ran on September 23. The SHA experiment was repeated on
September 28 on both an initialized service and a fresh service.

The build copied the checked-out `package.json`; the deployed process hashed its bytes and returned
a unique invocation nonce. The requested revision's file is 1766 bytes with SHA-256
`605690c24a411e6ebfe5222406b2e0d2a31447acad9c47a031686fa1f02733b3`. Every observed file was
2231 bytes with SHA-256 `50b56ac7caa1fc92e11529d1d655221c3c84f519c4d532aeb00b4e56215b205c`,
matching the public default branch. The fresh-service process was `RjwPrEJpTiyqd7Z9jQPtDw`.

This disproves pinning through the tested suffix syntax. It does not rule out a different Git-source
API or selector. Request acceptance and source metadata alone do not prove which bytes were built.

### Verified live (2026-08-05, account `prg1`, project `fabrika-test`) — updating a running installation

How the four platform services on `fabrika-test` were taken from a two-day-old build to `HEAD`. There
is no git remote on this repository and `buildFromGit` needs a public URL, so the source reaches the
platform as an upload: `zops push <service> --project fabrika-test`, which archives the working tree
(git-tracked plus untracked-not-ignored), uploads it, and runs the repository-root `zerops.yaml` setup
whose name matches the service hostname.

| Behaviour                                               | Result                                                                                          |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| One upload of this monorepo                             | 631.6 MiB expanded, **194.2 MiB** on the wire, ~48 s to upload                                  |
| A full `iam` / `operations` build+deploy                | **~3 min** each, warm `node_modules` cache                                                      |
| The `control` build (it also builds the dashboard)      | ~5 min                                                                                          |
| An env write's process (`stack.updateUserData`)         | `FINISHED` in **~2.6 s** — poll `zops process list --service <svc>` before pushing              |
| `putServiceEnv` on an EXISTING key, through `packages/` | Replaces in place: same record id, `lastUpdate` moves, value reads back byte-identical          |
| A rebuilt proxy picking up a changed manifest           | The build logs `wrote ./caddy.json (4 app(s))` — the count is the cheapest check that it landed |

Two ordering rules, both of which cost something if ignored:

- **Write the variable, wait for its process, then push.** A deploy racing a `userData`
  synchronisation dies on `userDataSyncRunning` and leaves the app version stuck `UPLOADING`, which
  `deployAppVersion` does not recover from.
- **Deploy the PROXY before the service it fronts, whenever its endpoint table is changing enforcement.**
  The order that matters is not the dependency order (IAM → Operations → control) but the exposure
  order: the application no longer enforces anything (ADR-0022), so a control plane at `HEAD` behind a
  proxy still carrying an older, more permissive manifest is an open API. IAM → Operations →
  **proxy** → control keeps the dependency order and never opens that window.

`fabrika platform deploy` applies both rules
([`installing-on-zerops.md`](installing-on-zerops.md#how-install-and-deploy-work)).

### Verified live (2026-08-21, account `prg1`, project `apps-test2`) — the project log service

`GET /project/{id}/log` answers `{ accessToken, expiration, url, urlPlain, urlInfo, urlUi }`. The URLs
point at a separate log service that takes the `accessToken` as a bearer.

| Call                                                       | Result                                                                                                                                                                                 |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `urlPlain` (`…/api/rest/log/plaintext`)                    | one `<RFC3339 timestamp> <tag> <message>` line per record                                                                                                                              |
| `url` (`…/api/rest/log`)                                   | `{ items: [{ id, timestamp, hostname, tag, content, message, client, appName, procId, msgId, structuredData, priority, severity, severityLabel, facility, facilityLabel, version }] }` |
| `urlInfo`                                                  | `{ tags: [...] }` — the distinct tags in the project: `zerops@zerops`, `zerops@setup`, `init`, `supervise-daemon`, `crond`, and one `zbuilder@<appVersionId>` per build                |
| `serviceStackId=<id>`, `limit=<n>`, `desc=1`, `tags=<tag>` | the query terms that work                                                                                                                                                              |
| `format=<x>`                                               | accepts only `rfc_3164`, `rfc_5424`, `raw`; anything else is a **400**                                                                                                                 |
| `from=<ts>` and any unknown term                           | **accepted and silently ignored** — the answer is the same as without it. Never rely on them                                                                                           |
| `limit=N` without `desc`                                   | the NEWEST N records in ASCENDING timestamp order (`limit=3` on a log that starts 15:50 answered 17:00:00, 17:00:00, 17:15:00); `desc=1` returns the same newest N newest-first        |
| `tags=zbuilder@<appVersionId>` WITHOUT `serviceStackId`    | exactly one app version's BUILD lines — the build runs on a separate builder stack, so combining the tag with the runtime `serviceStackId` returns nothing                             |
| `serviceStackId=<runtime id>`                              | RUNTIME lines of every version that ever ran on that service; they carry no version marker                                                                                             |

So a build log is selected by the version's tag, and a runtime window is cut client-side at the
version's `build.pipelineStart` (`getAppVersion` / `activeAppVersion.build` carries `pipelineStart`,
`startDate`, `endDate`, `pipelineFinish`, RFC3339 with nanoseconds). That cut is by time, not identity:
the outgoing container keeps logging past the new `pipelineStart`, so its own later lines still pass.
A build longer than `limit` needs no `desc` — each poll re-reads the newest window and the caller
dedupes. Consumed by `ZeropsApi.readBuildLog`.

## Fabrika placement mapping

The Fabrika platform project of the `standard` tier contains (the `light` tier has the same roles on
single-node databases and one shared `storage` bucket):

- `iam`, `operations`, `control`, and the only public `proxy` runtime;
- one shared `db` PostgreSQL service for IAM and control;
- a separate `operationsdb` PostgreSQL service for Operations;
- private `storage` for run logs and `operationsstorage` for raw events and
  source maps.

IAM and Operations deploy at once, then proxy, then control. Operations uses
`run.initCommands` for service-owned plus `platform-node` queue migrations,
`run.start` for its HTTP server and Postgres job consumer, and `run.crontab` for
health and notification maintenance. Its database and object store are separate
failure/capacity domains from IAM and control.

A `run.crontab` command runs in its own process, and the service log records only that it
started (`USER zerops pid <n> cmd /opt/zerops/bin/zsc crontab run crontab-0`) — nothing the
command writes to stdout or stderr is collected (seen 2026-08-21 on control's five-minute
maintenance: its `operations catalog sync: …` line never appears in the log; backlog 85).

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

Each application deploy writes `FABRIKA_RELEASE` as a literal into the selected setup's
`run.envVariables` of the execution descriptor, so the release travels with the version; the source
descriptor's bytes and digest are unchanged. The other managed keys (`FABRIKA_OPERATIONS_DSN`,
`FABRIKA_IAM_ISSUER`, `FABRIKA_IAM_APP_ID`, `FABRIKA_APP_ID`, `FABRIKA_ENVIRONMENT`, `FABRIKA_SERVICE_KEY`) are ordinary
service variables, overwritten before the build, and so are the membership transport's `FABRIKA_IAM_RPC_URL` and
`FABRIKA_IAM_RPC_KEY` of an application whose approved contract needs one, and each job's and webhook's key
(`FABRIKA_<KIND>_<NAME>_KEY`); a key of a workload the deploy no longer hands is deleted. Application-authored inputs and
secret writes may not use a framework-only name (`FRAMEWORK_VARIABLE_NAMES` and the job, webhook, public procedure,
connector, mail and platform transport families of `FRAMEWORK_VARIABLE_PREFIXES` in `@fabrika/auth-core`). The mail
family (`FABRIKA_EMAIL_*`) is the installation's transport, which a deploy writes, sensitive, only to an application
on an older framework release whose approved contract has a job that declares `mailer: 'installation'`. On framework
0.7 that application gets the platform transport instead: `FABRIKA_EMAIL_PROVIDER=platform` and
`FABRIKA_PLATFORM_MAIL_URL` plain, `FABRIKA_PLATFORM_MAIL_KEY` sensitive
([ADR-0064](../decisions/0064-applications-reach-the-platform-over-a-receiver-verified-transport-key.md)). The run checkpoint is `{ appVersionId, triggered }`; recovery polls a triggered
version and deletes an untriggered one
([ADR-0044](../decisions/0044-zerops-delivery-ownership-and-recovery.md),
`packages/provider-zerops/src/managed-env.ts`).

A contract application's execution descriptor is generated whole (`packages/provider-zerops/src/execution.ts`):
only the selected setup, with `FABRIKA_CONTRACT_DIGEST` beside `FABRIKA_RELEASE` as literals, an `httpGet`
readiness check of the contract's health endpoint, and the build checks. Its database and its object storage
are `${<host>_…}` references that Zerops resolves at runtime, so no credential passes through Fabrika:
`FABRIKA_APP_DATABASE_URL` names the application's one PostgreSQL service (or the namespace's), and
`FABRIKA_APP_STORAGE_ENDPOINT`, `_BUCKET`, `_ACCESS_KEY_ID` and `_SECRET_ACCESS_KEY` name its one
`object-storage` service (`apiUrl`, `bucketName`, `accessKeyId`, `secretAccessKey`). A second database or
bucket is refused. The bucket is accepted only with platform provenance, below.

Before any version is reserved, every application deploy reads back each declared service with
`GET /service-stack-by-name/{projectId}/{hostname}`: `subdomainAccess` must be `false`. An import cannot set
it, but an earlier enable survives every import. Zerops has no API to read a bucket policy back, so a bucket
is accepted only when this run's import created it (a `stack.create` process for it) or the
`FABRIKA_STORAGE_PROVENANCE` variable on the deploy service names its id. The first registration keeps the
buckets its collision-refusing import created in the environment's stored target, and the first deploy writes
them into that variable. A later import that creates a bucket records its id in the variable, not sensitive, as
soon as the import's processes finish and before any other step: a re-apply reports no `stack.create` for a
service that exists, so a run that failed after the import could otherwise never prove the bucket again. A
cancel does not stop that write; a lost lease or a failed write does, and then the run log names the bucket.
A variable written sensitive (releases up to v0.4.2) reads back `REDACTED` without sudo, so it names no bucket;
the next deploy that proves its bucket rewrites it readable. The refusal of an unproven bucket names both
remedies, neither of which needs sudo: when the bucket's `stack.create` process ran under the platform's token,
set the variable on the deploy service to the bucket's service id, not sensitive; otherwise delete the bucket
and deploy again.

The build container has no database, so a contract application's init commands run `fabrika db migrate`, then
`fabrika db codegen --verify` and `fabrika db test-isolation`, and its start script only starts the server: a stale
committed `schema.generated.ts` or a generated isolation case that did not pass fails an init command, which stops the
activation. The checks run before `run.start`, outside the readiness window (above), however long the isolation tests
take.

`FABRIKA_APP_DATABASE_URL` carries the PostgreSQL service's superuser on the direct port:

```
postgresql://${<db>_superUser}:${<db>_superUserPassword}@${<db>_hostname}:${<db>_port}/${<db>_dbName}?sslmode=disable
```

fabrika uses it only as the provisioning credential of the application's role family
([ADR-0017](../decisions/0017-service-owned-postgres-migrations.md)): `fabrika db migrate` creates `app_<id>` and
`run_<id>` with it and applies the migrations as `app_<id>`, the server and the crontab's jobs relaunch themselves as
`run_<id>` over the same host, port and options, and `fabrika db test-isolation` hands the generated tests a
throwaway `CREATEROLE` provisioner instead, which it grants `CREATE` on the database and drops afterwards; the
provisioner logs in for 15 minutes only, and the next run sweeps one that a killed run left behind. The
superuser, because the service's own user `db` can neither create roles nor create a schema; the direct port, because
pgBouncer on `portTls` refuses every role fabrika creates (both measured below). An application on a `cheap`
namespace gets the same URL for the shared `postgres` service. The `useSharedPostgres()` binding's own
`connectionString` is the `db` user's, `${postgres_connectionString}/${postgres_dbName}?sslmode=disable`, for an
application that connects by itself; an artifact built with its earlier `portTls` form still decodes, as the current
one.

Zerops gives a service one environment: `run.initCommands`, the start script, the launcher and the application all
start from it, so the superuser credential cannot be confined to `fabrika db migrate`. The launcher keeps it out of the
application's process (ADR-0017). No application configuration may reference a `superUserPassword` variable: the
manifest's services and `zerops.yaml`, a deploy-time variable and `secrets.put` each refuse it
(`platformOnlyServiceReference`, `packages/provider-zerops/src/service-references.ts`).

#### A contract with files sweeps hourly

A contract that declares a file kind (or, from a 0.4, 0.5 or 0.6 application, a file collection) gets
`fabrika job run fabrika-file-sweep` at minute 41 of every hour, on one container (`allContainers: false`): the
framework's sweep deletes the files no declared column references. The job's lease keeps two runs from overlapping.

#### UNVERIFIED: ClamAV in a scanning application's runtime container

A contract with a `scan: true` file kind (or file collection) gets `sudo apk add --no-cache clamav` and a first `sudo freshclam` in
`run.prepareCommands`, the same `freshclam` in `run.initCommands` (a failure there only logs: a container starts from
the prepared image, whose signatures are as old as its build), a daily `freshclam` crontab line on every container and
`fabrika job run fabrika-file-scan` every minute (`packages/provider-zerops/src/execution.ts`). The scanner refuses
signatures older than three days, so a container that cannot refresh them scans nothing and reports, rather than scan
with stale ones. Measured locally with `clamav/clamav:1.4` (2026-10-12): one `clamscan` over 21 small files took 11 s
and peaked at 0.99 GB resident, almost all of it the signatures. A scanning application's deploy service must
therefore declare `verticalAutoscaling: { minRam: 2 }` (`ZEROPS_SCAN_MIN_RAM_GB`); the build and the deploy refuse it
otherwise. Zerops ignores a changed `verticalAutoscaling` of an existing service on a re-import, so the deploy raises
an existing service (below). Not yet measured on a real account: that Alpine's `clamav` installs through
`prepareCommands`, that `freshclam` reaches its mirror from the build and the runtime, and the peak memory there.

#### Verified live (2026-10-15, account `prg1`, a disposable project) — a deploy raises the deploy service's minimum RAM

Observed live the same day (v0.4.5 and v0.4.6 on a fresh installation): with the runtime's 0.125 GB floor, the start
script's `fabrika db test-isolation` was killed (`memory limit exceeded`, exit 137) and the version went to
`DEPLOY_FAILED` on 2 of 3 first deploys onto a new container; the restarted process then passed. Measured locally, as
the summed anonymous RSS of the CLI and its `bun test` child: 161 MiB for the Notes example (38 cases) and 225 MiB for
the CRM example (133 cases), within about 1.5 s, beside some 45 MiB of Bun's mapped binary. `--smol` on the child saved
7 %, a forced collection in the CLI nothing. The serving pair (launcher and application) of Notes holds about 105 MiB
anonymous. Vertical autoscaling reacts in 10–20 s, so a spike this fast is killed before it scales.

So a deploy raises the deploy service's minimum RAM (`raise-start-memory`, `packages/provider-zerops/src/provider.ts`)
to `zeropsStartMinRam` (`src/execution.ts`): 0.5 GB for an application with a database, 2 GB for one that scans, before
it reserves the version. Measured on an `alpine/bun@1.3` service imported with `minContainers: 1, maxContainers: 2`:

| Call                                                                                                                                                     | Result                                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /service-stack/{id}` of the fresh service                                                                                                           | `customAutoscaling: { verticalAutoscaling: null, horizontalAutoscaling: { minContainerCount: 1, maxContainerCount: 2 } }`; `currentAutoscaling` carries every field: min 0.125 GB, max 48 GB |
| `PUT /service-stack/{id}/autoscaling` `{ customAutoscaling: { verticalAutoscaling, horizontalAutoscaling } }`, nulls but `minResource.memoryGBytes: 0.5` | **`{ process: null }`**; `currentAutoscaling` reads min 0.5 GB AT ONCE, every other field unchanged; a field sent `null` inherits                                                            |
| The same body under the OpenAPI's `BaseCustomAutoscaling` keys `verticalAutoscalingNullable` / `horizontalAutoscalingNullable`                           | **200 `{ process: null }`, and the WHOLE custom autoscaling is reset**: the minimum stays 0.125 GB and `maxContainerCount` falls back to 10                                                  |
| `{ customAutoscaling: { verticalAutoscaling: { minResource: { memoryGBytes: 0.75 } } } }`                                                                | Applied, and `horizontalAutoscaling` reset to null (`maxContainerCount` 10): a PUT replaces the whole custom object                                                                          |
| fabrika's client: read, change only the minimum, send it back, read back (a custom `startCpuCoreCount: 3` and 1–2 containers set before)                 | Minimum 0.125 → 0.5 GB; the custom `startCpuCoreCount` and the container range kept                                                                                                          |

The step therefore sends the custom object it read WHOLE, under `verticalAutoscaling` / `horizontalAutoscaling`, with
only `minResource.memoryGBytes` changed, and decides by reading `currentAutoscaling` back; anything short of the
minimum fails the deploy before a version exists. It never lowers a minimum. The `custom-autoscaling-raises-min-ram`
fact row pins both the working body and the reset under the OpenAPI's keys.

#### Measured in production (2026-10-16) — an application's database connections

Zerops' documentation (PostgreSQL, "Connection limits" and "Scale & profiles", read 2026-10-15) states the limits:

| RAM step of the service | `max_connections` OLTP / WriteHeavy | OLAP |
| ----------------------- | ----------------------------------- | ---- |
| 0.25 GB                 | 20                                  | 10   |
| 0.5 GB                  | 25                                  | 12   |
| 1 GB                    | 50                                  | 25   |
| 2 GB                    | 100                                 | 50   |
| 4 GB                    | 200                                 | 100  |
| 8 GB                    | 400                                 | 200  |
| 16 GB and more          | 500                                 | 200  |

- RAM counts in steps (0.25, 0.5, 1, 2, 4 GB, then multiples of 8 GB): 7 GB has the 4 GB limit.
- 3 connections are kept for superusers, and Zerops itself uses up to 4 (monitoring, health checks, backups).
- The limit cannot be overridden. Raising the minimum RAM to a higher step raises it. On a single-node service that
  restarts PostgreSQL once (measured 2026-10-16, below); Zerops' documentation says an HA service rolls through its
  nodes (not measured).
- pgBouncer on `portTls` would multiplex, but it admits only `db`, `postgres` and `zps` (measured 2026-10-15,
  below), so an application's roles connect on `port` and count against `max_connections` directly.

Measured in production on a contract application with 1–2 containers and a `postgresql:single@18` at `oltp-hobby`
(0.25 GB, `max_connections` 20): two deploys failed in the start script's `fabrika db test-isolation` with
`PostgresError: remaining connection slots are reserved for roles with the SUPERUSER attribute` (SQLSTATE 53300),
reported as 394 and then 414 of 420 generated cases passed. At the peak of one run `pg_stat_activity` held 20 client
backends: 12 of the serving application's runtime role, 2 of the run's provisioner, 1 of its migration role, 1
`postgres` and 4 without a user (Zerops). Each process of `@fabrika/app/bun` opened up to 10 connections.

Measured locally against `postgres:18` (2026-10-16), the peak client backends of one `fabrika db test-isolation` run
of the Notes example (38 cases) and of the CRM example (133 cases): 5 with the test kit of v0.4.7, 4 since it holds
one provisioning connection per file for the schema's lock and the catalog. None is left once the run ended.

So a deploy sizes each process's connections in `size-database` (`packages/provider-zerops/src/database-budget.ts`):
of `max_connections` at the database's minimum RAM, 7 are never the application's and 5 are one container's start
script; the rest is shared by twice the deploy service's maximum container count and one process per crontab job, at
most 10 each, and handed over as `FABRIKA_APP_DATABASE_CONNECTIONS`. Below 2 each, it raises the application's own
database to the smallest step that gives 2 (the Notes example, 4 containers and 2 jobs: 0.25 → 1 GB; Zerops charges
$0.75 per 0.25 GB and 30 days); a namespace's shared `postgres` is never raised. The test kit waits up to 60 s for a
slot on SQLSTATE 53300, and `fabrika db test-isolation` reports a refused connection as such
([ADR-0043](../decisions/0043-validate-and-render-one-zerops-descriptor-meaning.md)).

#### Verified live (2026-10-16, account `prg1`, a disposable project) — the autoscaling API raises a PostgreSQL service's minimum RAM and its `max_connections`

`size-database` raises a database with the read-modify-write that raises a runtime's minimum RAM (`raiseMinRam`,
verified on `alpine/bun@1.3`, above). Measured twice on a `postgresql:single@18` imported with `profile: oltp-hobby`,
through that same function. The SQL client was a small Bun service in the same project. It opened one fresh connection
as the superuser `postgres` once a second and read `max_connections` and `pg_postmaster_start_time()`:

| Measurement                                            | Result                                                                                               |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| The fresh service                                      | `autoscalingProfileId` `oltp-hobby`, `currentAutoscaling` minimum 0.25 GB, `max_connections` **20**  |
| The same type imported without `profile`               | `oltp-staging`, minimum **1 GB**, `max_connections` 50                                               |
| `raiseMinRam` from 0.25 to 1 GB                        | Accepted. `currentAutoscaling` reads 1 GB back when the call returns, 2.1 s and 4.1 s after it began |
| `max_connections` after the raise                      | **50**, first read 15 s and 18 s after the raise began                                               |
| `pg_postmaster_start_time()`                           | Changed in that same sample: the raise **restarts PostgreSQL once**, between two samples 1 s apart   |
| Fresh connections during the restart (76 and 79 tries) | **None refused**; the slowest answer of the second run took 56 ms                                    |

So the limit follows the minimum RAM step and the documented table (0.25 GB: 20, 1 GB: 50), and `size-database` need
not wait for it: the build that follows the step takes minutes, so the init commands and the new containers meet the
new limit. The version still serving sees its open connections closed once, by the restart; a fresh connection is not
refused. A service whose minimum the platform does not report is sized as 0.25 GB, which never overstates its limit.
The rows need a build and run with `FABRIKA_LIVE_ZEROPS_SLOW=1`.

| Behaviour                                                                                 | Row                                          |
| ----------------------------------------------------------------------------------------- | -------------------------------------------- |
| The custom autoscaling raises the minimum RAM of a PostgreSQL service, read back at once  | `postgres-custom-autoscaling-raises-min-ram` |
| `max_connections` follows within 3 minutes, through one restart that refuses at most 10 s | `postgres-max-connections-follow-min-ram`    |

#### Verified live (2026-10-15, account `prg1`) — an application's database roles and the two ports

Measured on a `postgresql:single@18` service that an application's private import created, after the first deploy of
a contract application with a database failed in `run.initCommands`. `fabrika db migrate` connected as `db`, read
`rolsuper` and `rolcreaterole` of `current_user`, found neither and stopped before anything ran as `db`. The rest was
measured from a client inside the project.

| Fact                                                                     | Result                                                                                    |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| The service's own user `db`                                              | **Neither a superuser nor `CREATEROLE`**                                                  |
| The owner of the database `db`                                           | **`postgres`**, so `db` holds no `CREATE` on it and cannot create a schema                |
| `superUser` / `superUserPassword`                                        | The superuser `postgres`; it logs in on `port` (5432) and on `portTls` (6432)             |
| A login role created in the database, on `portTls` (6432)                | **Refused: `password authentication failed` (`08P01`)** — pgBouncer's user list is static |
| The same role on `port` (5432)                                           | Connects                                                                                  |
| Who logs in on `portTls`                                                 | Only `db`, `postgres` and `zps`                                                           |
| `Bun.SQL` on `port` (5432) with `sslmode=require` / `prefer` / `disable` | Connects; `ssl = true` / `true` / `false`                                                 |

So a contract application's provisioning credential is the superuser, and its database URL names the direct port with
`sslmode=disable` (above): `postgresql:ha@18` offers no TLS there (2026-08-19), and `Bun.SQL` 1.3.14 with
`sslmode=prefer` does not fall back to plaintext against a server without TLS — it waits out its 30 s connection
timeout (measured locally against `postgres:18`, whose default has no TLS). The connection stays inside the project's
network, as the proxy's plain-HTTP hop to an application does. On one installation the first deploy had been unblocked by hand, as `postgres`, with
`ALTER ROLE db CREATEROLE` and `GRANT CREATE ON DATABASE db TO db`; nothing needs that now. There the role family that
`db` created is taken over by the superuser at the next deploy: `fabrika db migrate` resets both passwords to the
superuser's derivation, and `db` keeps `CREATEROLE`, `CREATE` on the database and its membership in the migration role
until someone revokes them.

| Behaviour                                                                   | Row                                         |
| --------------------------------------------------------------------------- | ------------------------------------------- |
| The `db` user is neither a superuser nor holds `CREATEROLE`                 | `postgres-service-user-cannot-create-roles` |
| The database `db` is owned by `postgres`, so `db` cannot create a schema    | `postgres-database-owned-by-superuser`      |
| A login role fabrika creates is refused on `portTls` and connects on `port` | `postgres-new-role-only-on-direct-port`     |
| The superuser `postgres` logs in on `port` and on `portTls`                 | `postgres-superuser-logs-in-on-both-ports`  |

#### UNVERIFIED: a role fabrika creates connects on the direct port of `postgresql:ha@18`

The 2026-10-15 measurements were made on `postgresql:single@18`. On `ha` the service's own user connects to `port`
with `sslmode=disable` (2026-08-19); a role created in the database was not tried there. If it is refused, a contract
application on an `ha` service fails its first `fabrika db migrate` when the migration role connects.

| Behaviour                                                             | Row                                              |
| --------------------------------------------------------------------- | ------------------------------------------------ |
| A login role fabrika creates connects to `port` on `postgresql:ha@18` | `unverified-postgres-ha-new-role-on-direct-port` |

A `SECURITY DEFINER` function the platform installed in the database and left callable by `PUBLIC` would stop every
deploy (ADR-0017); none is known, but none was looked for.

#### UNVERIFIED: a build lifts a SENSITIVE service variable through `${RUNTIME_…}`

A contract build uploads its SPA source maps to Operations as its last command
(`fabrika-source-maps` of the same pinned `@fabrika/check`). Its bearer is the run-scoped credential Control mints; the
deploy writes it as the sensitive service variable `FABRIKA_SOURCE_MAP_UPLOAD_KEY` before the build request, and the
generated `build.envVariables` lift it as `${RUNTIME_FABRIKA_SOURCE_MAP_UPLOAD_KEY}`, beside the literal
`FABRIKA_SOURCE_MAP_UPLOAD` (destination and asset roots, no secret). The lift is verified for a plain env-API
variable (2026-08-03 above); for a sensitive one it is not yet measured. If Zerops hands the build an empty or
`REDACTED` value, the upload refuses, the build log reports `state=incomplete`, and the deploy still succeeds with its
release artifacts incomplete. The variable stays readable to the runtime until the next deploy replaces or removes it.

#### UNVERIFIED: a managed service's backup schedule, set through the API

Zerops has no point-in-time recovery. A PostgreSQL backup is a logical `pg_dump` on a per-service schedule, daily
(00:00–01:00 UTC) by default, so a single-node database loses everything since its last backup when its node fails.
`platform deploy` therefore sets the platform database `db` (IAM and control, on both tiers) to hourly as its last
step (`ensureBackupPeriod`, `installation/deploy.ts`). `operationsdb` keeps the default. A light installation
created before `operationsdb` existed keeps Operations in `db`, so the step leaves `db`'s schedule alone there and
warns: hourly dumps would copy Operations' whole, unpruned error history.

Read off the published OpenAPI document, not measured:

| Endpoint                                | Body / response                                                                                                                                      |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /service-stack/{id}/backup`        | `ListBackups` → `{ files[], backupPeriod, defaultRetentionPolicy, retentionPolicy? }`                                                                |
| `PUT /service-stack/{id}/backup-config` | `ConfigureBackup`, `{ backupPeriod?, retentionPolicy? }` → `{ process? }`. "Sets BACKUP_PERIOD env, retention policies, and triggers user data sync" |
| A retention policy                      | Nine required fields: `maxTotalFiles`, `maxTotalGiB`, `protectedTags`, and `min`/`max` of `Daily`, `Weekly`, `Monthly` (counts per backup tag)       |

The step reads the configuration. It replaces only a period that is empty or once a day (`<minute> <hour> * * *`,
the shape of the default); any other period is someone's choice and is kept. It sends `0 * * * *` with the retention
it read (the service's own, else `defaultRetentionPolicy`) whole, waits for a returned process, and reads the period
back. A second run changes nothing. Until the row below has run, nothing the step meets fails the deploy: a refused
write, a response that does not parse, or a read-back that differs is a warning naming the manual step. A null
`protectedTags` reads as the empty list. Unverified:

- the format of `backupPeriod` and of the default: the GUI documentation describes a 5-field cron
  (`min hour dom mon dow`); the read-back is compared byte for byte;
- whether a PUT without `retentionPolicy` resets the retention, and whether `defaultRetentionPolicy` is what applies
  while `retentionPolicy` is absent (sending the default turns it into the service's own);
- how an hourly backup is tagged. The documentation says every automatic backup gets `daily`; if so, `maxDaily`
  counts hours instead of days, and `maxTotalFiles` (at most 50 per service) caps it further. The restore points
  then reach back hours to about two days, and only `minWeekly`/`minMonthly` keep older ones. Read the row's
  printed default retention before relying on the history: the step may need to raise `maxDaily` or use a coarser
  period;
- whether a `backup-config` write restarts the database ("triggers user data sync").

| Behaviour                                                                                            | Row                                  |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------ |
| The period of a `postgresql:single@18` reads back as set, its retention as sent, a re-run is a no-op | `postgres-backup-period-round-trips` |

The row imports its own database and prints what a fresh one reads, so its log records the format; it runs with
`FABRIKA_LIVE_ZEROPS_SLOW=1`.

### The checker version

Every contract application build fetches the checker by version: `bun x -p @fabrika/check@<version>`, for
`fabrika-check` and `fabrika-source-maps`. `<version>` is the release of the reader that read the application at the
run's commit (`ProviderApprovedAccess.checker`): the newest patch of the framework minor its `bun.lock` pins, so an
application is checked by the rules of the minor it was written against
([ADR-0062](../decisions/0062-a-platform-release-serves-older-framework-releases.md)). Not the exact pinned patch: a
patch never changes the contract language, and an early one may lack a tool (`@fabrika/check@0.4.1` has no
`fabrika-source-maps`). A 0.4 application built on a 0.4 installation was checked by that installation's 0.4 checker
the same way.

`FABRIKA_CHECK_VERSION` is the `package.json` version of `@fabrika/provider-zerops`. Control runs the git checkout of
the installation's tag, not the published tarballs, so that version is the source version of the checkout. A release
sets it before it is tagged ([`release-process.md`](release-process.md#the-source-version)).

`platform install` and `platform deploy` ask npm for `@fabrika/check` at `FABRIKA_CHECK_VERSION` after they prepare the source and
before they contact Zerops. A 404 refuses the checkout (`this checkout is version X, which is not published yet`);
any other answer or no answer is an error, never a pass. Between a release's bump commit and its publish, `main`
is refused this way. An earlier tag carries the source version `0.0.4`, which npm never had, so an installation
needs a release whose source carries its version.

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
[ADR-0022](../decisions/0022-the-proxy-is-the-only-enforcement-point.md). Since the project L7
balancer terminates TLS, Caddy needs neither ACME nor certificate persistence.
