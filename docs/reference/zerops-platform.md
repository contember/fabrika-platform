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

Because the balancer terminates TLS and routes domains, a service behind it sees
the **balancer** as its socket peer, not the client. Whether the balancer
forwards a client address, whether it drops a caller-supplied `X-Forwarded-For`
prefix, and what source range it dials from are **all unconfirmed** — the public
docs say nothing, and no live run has measured it. Fabrika therefore configures
no Caddy `trusted_proxies` range, so `{http.request.client_ip}` is the balancer
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

| Purpose                                | Endpoint                                                             | Body / response                                                                                  |
| -------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Apply an import to an existing project | `POST /project/{id}/service-stack/import`                            | `{ yaml }` → `{ projectId, projectName, serviceStacks[] }`                                       |
| Create a project from an import        | `POST /client/{id}/project/import`                                   | same shapes                                                                                      |
| Trigger build+deploy                   | `PUT /service-stack/{id}/trigger-pipeline`                           | `{ buildFromGit?, zeropsYaml?, zeropsSetup?, startWithoutCode?, userData?, … }` → `{ process? }` |
| Poll a version                         | `GET /app-version/{id}`                                              | `{ id, status, sequence, serviceStackId, build{…} }`                                             |
| List versions                          | `GET /service-stack/{id}/app-version`                                | `{ list[], totalCount }`, `limit`/`offset`/`statuses`                                            |
| Cancel a build                         | `PUT /app-version/{id}/cancel-build`                                 | → `{ success }`                                                                                  |
| Read a service's env vars              | `GET /service-stack/{id}/env`                                        | → `{ items[] }`, each `{ id, key, content, type, sensitive }`                                    |
| Write a service-level env var          | `POST /service-stack/{id}/user-data`, `PUT`/`DELETE /user-data/{id}` | `{ key, content }` — `PUT` needs BOTH fields                                                     |
| Project-level env vars                 | `POST /project/{id}/env`, `PUT /project-env/{id}`                    | `{ key, content, sensitive }` — **fabrika never calls these** (ADR-0004)                         |
| Log access                             | `GET /project/{id}/log`                                              | `{ accessToken, expiration, url, urlPlain, urlInfo, urlUi }`                                     |

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

### Verified live (2026-08-03, account `prg1`)

The following were confirmed against a real account and are no longer inferences.

| Behaviour                                                                           | Result                                                                                                                         |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| A variable written through the env API resolves `${service_var}` at container start | **Yes** — identical to one written in `run.envVariables`                                                                       |
| A BUILD container can read its service's env-API variables directly                 | **No** — every one reads as the empty string, silently                                                                         |
| `build.envVariables: { X: '${RUNTIME_X}' }` lifts them into the build               | **Yes**, and it resolves nested references too                                                                                 |
| `GET /service-stack/{id}/user-data`                                                 | **Always 400 `serviceStackNotFound`**, before AND after a successful deploy                                                    |
| `POST /service-stack/{id}/user-data`                                                | Works from the moment the service exists                                                                                       |
| `POST /user-data/search` (with `clientId` **and** `serviceStackId`)                 | Works, but is not in the published OpenAPI document and needs a `clientId` — see `/env` below                                  |
| Secret value read-back                                                              | **Yes.** Env-API writes are stored `type: SECRET` and `content` returns the plaintext to a write-capable token                 |
| `run.envVariables` visible through the search endpoint                              | Yes, as `type: ENV`                                                                                                            |
| Custom variables prefixed `ZEROPS_`                                                 | **Refused** — 400 `userDataZeropsPrefixForbidden`. The prefix is reserved                                                      |
| `zeropsSetup` in an import without `buildFromGit`                                   | **Refused** — 400 `projectImportInvalidParameter`, `{"iam.buildFromGit": ["parameter is required for use of pipelineConfig"]}` |
| Enabling subdomain access on a never-deployed service                               | **Refused** — "Service stack is not http or https". Needs a deployed HTTP port first. See the 08-05 section below              |
| One generated subdomain per HTTP port                                               | **Yes** — `<hostname>-<hash>-<port>.<region>.zerops.app`                                                                       |
| A version alias such as `alpine/bun@1.3`                                            | Resolves to the newest concrete version (`1.3.9`). `zops catalog` lists only concrete ones                                     |
| `alpine/go@latest` building Caddy 2.10.2                                            | **Works** — the base is Go 1.22 and Go's automatic toolchain download supplies the rest                                        |

Two consequences worth stating separately, because they are ordering constraints
rather than facts about a field:

- **Never read before writing a service variable.** The list endpoint's 400 is not
  "no such service" and not "not deployed yet" — it never succeeds. A reconciler
  that lists first fails on every environment, always.
- **A second deploy cannot start while a `userData` synchronisation is running**
  ("Process of synchronizing userData is already running"). Writing variables and
  then immediately pushing needs a retry loop. This does NOT apply to the writes
  themselves — see below.

### Verified live (2026-08-05, account `prg1`, project `fabrika-test`)

Written while fixing the write path. Every row was produced with `zops` against the
live account; the operation ids are `zops api --list --tag UserData`.

| Behaviour                                                                   | Result                                                                                                                                |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /service-stack/{id}/user-data` (`ListServiceStackUserData`)            | **Still always 400 `serviceStackNotFound`** — on `notesapi`, `iam`, `proxy` and `db`, with and without `limit`/`offset`/`keyContains` |
| `POST /service-stack/{id}/user-data` (`CreateUserData`)                     | Works. Returns a **process**, not the created record — the new record's id is not in the response                                     |
| `POST` on a key the service already has                                     | **400 `userDataDuplicateKey`**, "not unique in service stack frame of reference". Nothing is written; it does not replace             |
| **`GET /service-stack/{id}/env` (`GetServiceStackEnvList`)**                | **Works on every service** — ACTIVE, managed (`db`, `storage`) and a stopped build runtime alike. This is the read path               |
| The `id` in that response                                                   | **Is the user-data record id** — the same value `POST /user-data/search` returns, and accepted by `PUT`/`DELETE /user-data/{id}`      |
| `PUT /user-data/{id}` (`UpdateUserDataById`)                                | **Replaces in place**: same record id, new `content`, `lastUpdate` moves. Non-destructive — no delete window exists                   |
| `PUT /user-data/{id}` with `content` but no `key`                           | **Refused** — 400 `invalidUserInput`. Both fields are required even when the key is unchanged                                         |
| `GET /user-data/{id}` (`GetUserDataById`)                                   | Works — a single record by id, unlike the list                                                                                        |
| Three `POST`s to one service back to back                                   | **All three succeed.** The "synchronizing userData is already running" conflict gates a DEPLOY, not another write                     |
| `type: ENV` variables (from the service's `zerops.yaml` `run.envVariables`) | **Absent from `/env`, present in `POST /user-data/search`** — and they still make a `POST` answer `userDataDuplicateKey`              |
| The error envelope                                                          | `{ error: { code, message, meta[] } }`. `code` is a stable identifier; `message` can quote the value it rejected                      |

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
halves the idle floor of the data plane. The `light` tier is one `postgresql:single@18` at
`oltp-staging`.

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
`run.healthCheck.{failureTimeout,disconnectTimeout,recoveryTimeout,execPeriod}`. **A document that
satisfies the published schema is undeployable**, so `installation-zerops/zerops/validate.ts` retypes
exactly those six pointers to `string` before validating, and throws if the published schema ever stops
saying `integer`. `provider-zerops/src/types.ts` carries the matching `ZeropsDuration` type.

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

#### The PostgreSQL connection target

Read with `zops env show --service <svc> --json`, on a service deliberately NOT named `db`.

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

So the canonical fabrika DSN on Zerops is

```
${<host>_connectionString}/${<host>_dbName}?sslmode=require
```

Both suffixes are load-bearing. Without the database path the driver falls back to the USER name — which
lands on the right database only because the platform always names both `db`, a convention no document
states. And `require` is the strongest TLS mode available: it encrypts, and `verify-full` cannot work
without Zerops' CA. This is still the DIRECT port; 6432 is pgBouncer, whose transaction pooling would
break the session-level advisory lock the migration runner takes.

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
  its import documents, because it is what ADR-0007's `assertOnlyPublicService` reads to prove no service
  other than the proxy is claimed public — but the generated artifacts' header now states that applying
  the file publishes nothing, and names the call that does.

#### `zeropsSubdomain` is a NAME, not a state

`GET /service-stack/{id}/env` returns a `READ_ONLY` `zeropsSubdomain` variable. It is not evidence that a
subdomain is live:

| Behaviour                                                        | Result                                                                                |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `zeropsSubdomain` on a service whose subdomain was NEVER enabled | **Present and non-empty** — a full URL, on live `notesapi` (`subdomainAccess: false`) |
| `zeropsSubdomain` after `DisableSubdomainAccess`                 | **Unchanged.** Same value, while the host answers 502                                 |
| `zeropsSubdomain` on a service with several HTTP ports           | **Newline-separated, one URL per HTTP port** — six lines on the live `proxy`          |
| The host form                                                    | `<hostname>-<4 chars>-<port>.<region>.zerops.app`                                     |

Read the service's `subdomainAccess` to know whether a subdomain is live, and `zeropsSubdomain` only to
learn what it is called.

### Verified live (2026-08-08, account `prg1`, throwaway project `fabrika-wu1-probe`) — a proxy before it fronts anything

Measured to settle whether a Zerops installation can be brought up from an empty project. One `alpine@3.21`
service named `proxy`, imported with `startWithoutCode: true`, then built from the public repository.

| Behaviour                                                                 | Result                                                                                    |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `zeropsSubdomain` **before any deploy**                                   | **Present**, a single line with **no port segment**: `https://proxy-2b16.prg1.zerops.app` |
| The same variable **after** a deploy publishing six HTTP ports            | Six lines, `https://proxy-2b16-<port>...`, one per port                                   |
| The `<4 chars>` segment across that transition                            | **Unchanged** (`2b16` before and after)                                                   |
| Lag between the version reaching `ACTIVE` and the six lines appearing     | **None measurable** — both were true in the same 10 s poll                                |
| `POST /service-stack/{id}/user-data` on a service that has never deployed | **Works**, immediately after the import's processes report `FINISHED`                     |
| Service fields `zeropsSubdomain` / `ports` before a deploy                | **Absent** and `[]` — the subdomain is a generated ENV VARIABLE, never a service field    |
| `enableSubdomainAccess` on a freshly deployed service                     | `subdomainAccess` read back `true` within 5 s                                             |

**A proxy carrying `FABRIKA_PROXY_MANIFEST_JSON={"apps":[]}` is a complete, deployable service.** It built
in ~190 s, deployed in ~60 s, reached `ACTIVE`, and answered **404** on public listener 8080 — which is
exactly what `zerops/setups.ts:409` claims an empty app list produces. This is what makes a two-pass
bring-up possible: pass 1 publishes the ports, pass 2 reads the per-port names and writes the real manifest.

Two limits on the above. The port segment is **predictable in hindsight** (`proxy-2b16` + `-<port>`), but
that is one observation of one format, and `derivePlatformHosts` still refuses to compose a hostname rather
than read one. And this run gave the proxy a legal `FABRIKA_IAM_URL`/`FABRIKA_IAM_KEY`, so it does **not**
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
app version and uploads source through the operator-owned GitHub App described by
[`47`](../backlog/47-give-the-zerops-path-a-private-git-source.md) and ADR-0029.

Two smaller things, both worth knowing before debugging one:

- **The refusal names nothing.** A trigger with no source answered `Service stack not found` for an
  empty body and `Invalid parameter provided` when only `zeropsSetup` was set — two different errors
  for the same missing input, neither mentioning a build source, on a service id that the very next
  call accepted.
- **A `stack.build` that fails before it creates a container leaves its app version at
  `WAITING_TO_BUILD` permanently.** The process was `FAILED` 500 ms in and carried no message; the
  version had not moved eight minutes later. Polling the version alone therefore cannot distinguish a
  failed build from a queued one — see
  [`70`](../backlog/70-a-failed-zerops-build-hangs-await-deploy-for-seventy-minutes.md).

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
longer readable. The same delete also removed a second version that had received no upload. Fabrika
must therefore persist its own upload-complete checkpoint, and it can clean both ambiguous pre-trigger
states with the exact API available to the project integration token. The service was deleted.

### Fabrika application source transport

Fabrika application deploys no longer use `buildFromGit`. Public and private GitHub repositories share
one provider lifecycle: source resolves the exact commit and registered root `zerops.yaml` digest;
control creates and records an application version; source uploads the bound Git-object archive; and
control calls `build-and-deploy` with the registered descriptor and selected setup. Public
`buildFromGit` remains in use for Fabrika-owned installation artifacts such as the proxy, not for an
application deployment.

The installation has a private `source` service on `http://source:3000`. It installs `git`, exposes
only an unauthenticated private-network `/healthz` liveness endpoint, and authenticates every RPC before
reading its bounded body. The shared RPC secret is `FABRIKA_SOURCE_RPC_KEY` on source and
`FABRIKA_ZEROPS_SOURCE_RPC_KEY` on control. Source receives no Zerops token. The optional
`GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY` pair is all-or-none and exists only on source; public
repositories work anonymously without it. The independently optional `GITHUB_WEBHOOK_SECRET` stays on
control, which verifies webhook HMAC locally.

Production repository and REST origins are fixed to `github.com` and `api.github.com`. There is no
operator-facing GitHub Enterprise or GitHub API-base setting; alternate origins are dependency-injected
test seams only. Before any Git fetch, source asks GitHub REST for the exact commit and recursive tree.
GitHub's [Get a tree](https://docs.github.com/en/rest/git/trees#get-a-tree) response is limited to
100,000 entries or 7 MB. Fabrika admits at most 50,000 entries and 512 MiB of declared expanded blob
bytes, bounds the recursive-tree response to 8 MiB and refuses a `truncated` response. The 8 MiB
transport ceiling leaves JSON overhead around GitHub's documented 7 MB tree limit; the stricter
Fabrika admission limits are the entry count and expanded repository size. Source then rechecks the
fetched Git objects against the approved paths, modes, object ids and sizes before archiving them. A
different exact commit, descriptor digest or blob size fails before upload.

The source service accepts only the measured `prg1` upload destination: HTTPS host
`proxy.app-prg1.zerops.io`, exact path `/api/rest/object-storage/upload`, empty userinfo, no explicit
port or fragment, and a non-empty signed query. It refuses redirects. The credential-bearing upload URL
is present only in the authenticated request and live PUT; neither side persists or logs it.

Control's outer RPC deadlines are 45 seconds for installation lookup, five minutes for resolve,
20 minutes for upload and 30 seconds for cancellation. Source expires installation lookup after
30 seconds, resolve after four minutes and upload after 15 minutes, leaving time for a redacted response
before the outer deadline. The upload PUT itself is bounded to ten minutes. Caller cancellation is
propagated through GitHub REST, Git operations, response reads, archive cleanup and upload.

This transport, topology and upgrade flow are locally implemented and tested. They have not yet passed
the active sprint's live gate: the same commit must reach `ACTIVE` through application-version upload
once while public and once while private in `fabrika-install-test`, and the live logs, process data and
application-version metadata must be inspected for credentials. The subsequent browser handoff and
Operations exception-ingest witness is also live-only.

### Verified live (2026-08-05, account `prg1`, project `fabrika-test`) — updating a running installation

How the four platform services on `fabrika-test` were taken from a two-day-old build to `HEAD`. There
is no git remote on this repository and `buildFromGit` needs a public URL
([backlog 47](../backlog/47-give-the-zerops-path-a-private-git-source.md)), so the source reaches the
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
- **Deploy the PROXY before the service it fronts, whenever the gate list is widening enforcement.**
  The order that matters is not the dependency order (IAM → Operations → source → control) but the exposure
  order: the application no longer enforces anything (ADR-0022), so a control plane at `HEAD` behind a
  proxy still carrying an older, more permissive manifest is an open API. IAM → Operations → source →
  **proxy** → control keeps the dependency order and never opens that window.

**The platform installation's proxy manifest is generated in two halves.** The installation-independent
half — which apps exist, their ids, their private upstreams, the public listener each answers on and
their gates — is declared in `packages/installation-zerops/zerops/proxy-manifest.ts` and rendered into
the committed `zerops/generated/platform-proxy-manifest.ts` by `bun run --filter
@fabrika/installation-zerops gen`; CI's `gen:check` fails when it drifts from `CONTROL_PROXY_GATES` or
`OPERATIONS_PROXY_GATES`. The hosts and the browser-facing scheme belong to one installation and are
bound at deploy time by `resolvePlatformProxyManifest` (`packages/installation-zerops/src/proxy-manifest.ts`).
`localPlatformProxyManifest` (`@fabrika/local-stack`) is a CALLER of the same generator with the local
hosts, so the two compositions can no longer disagree; `compileNamespaceProxyManifest`
(`packages/control/src/node/zerops-proxy.ts`) remains separate — it builds an APP namespace's manifest
from the control registry.

IAM's app id on a deployed installation is `iam`. The live document said `iam-local` until this
generator replaced it, inherited from the local composition it was copied from at bring-up; the id is
inert for an app whose every gate rule is `public`, so correcting it costs nothing.

### `fabrika platform deploy --provider=zerops`

Both ordering rules above, plus the manifest composition, now live in code:
`packages/installation-zerops/src/deploy.ts`. On Zerops the command owns the WHOLE ordered sequence —
resolve the project and its services, write each service's environment, deploy
IAM → Operations → source → proxy → control waiting for each, reconcile the console's schema, ensure the public
entry point — so an operator's pipeline calls one step. On Cloudflare the same command stays narrow and
the scaffolded workflow keeps the order. The asymmetry is deliberate
([ADR-0027](../decisions/0027-platform-deploy-is-as-wide-as-the-provider-needs.md)); its full flag and
variable surface is the `usage` string in `packages/installation-zerops/src/index.ts`.

Three behaviours worth knowing before reading that file:

- **The manifest is MERGED.** On the light tier an application shares the project and therefore the
  platform proxy's one `FABRIKA_PROXY_MANIFEST_JSON` — `fabrika-test` carries `notes` → `notesapi:3000`
  beside the three platform apps. Application entries are carried through unchanged; an entry standing
  on one of the platform's own public hosts is superseded and reported, because a host belongs to
  exactly one app.
- **Hosts come from `zeropsSubdomain` unless the operator names them.** That variable is a NAME and not
  a state (see above), so it can be read one step before `enableSubdomainAccess`. Naming all three hosts
  instead marks the installation `custom-domain`, and no subdomain is published.
- **Every variable is read and compared before it is written**, through `GET /service-stack/{id}/env`,
  so a re-run writes nothing. `putServiceEnv` itself stays write-first — it must also work on a service
  that has never been deployed.

Measured against the live `fabrika-test` on 2026-08-06 with `--dry-run` (reads only): of the
per-installation variables the command derives, only `ENVIRONMENT` on `operations`, `control` and
`proxy` and the proxy manifest differ from what was placed by hand. Every origin — `ISSUER`,
`FABRIKA_IAM_ADMIN_ORIGINS`, `FABRIKA_CONTROL_DOMAIN`, `OPERATIONS_ARTIFACT_ORIGIN`,
`FABRIKA_OPERATIONS_PUBLIC_HOST`, `FABRIKA_IAM_URL`, `FABRIKA_ZEROPS_PROXY_IAM_URL` — reproduces the
live value byte for byte, and the composed manifest reproduces `vozka`, `operations` and `notes`
identically while replacing `iam-local` with `iam`.

### `fabrika platform install --provider=zerops`

The from-scratch bring-up: `packages/installation-zerops/src/install.ts`. The operator creates an
EMPTY project (core package `LIGHT`, `envIsolation: service` — a project-level setting the platform
accepts at creation only and never hands back, so nothing can verify it), and this command does the
rest. It is interactive and laptop-side, confirming before every step that leaves the operator's disk,
and it is the only command that generates a credential for an installation.

Its shape is decided by three of the facts above:

- **Two passes, because the public hostnames come from a DEPLOY.** `zeropsSubdomain` names one host
  per deployed HTTP port and the proxy's ports come from its app version, not from the import — so
  pass 1 writes the legal empty manifest `{"apps":[]}` plus a syntactically valid IAM URL and key,
  builds the proxy alone, and reads the six lines back. Pass 2 writes everything else and hands the
  whole ordered sequence to `platform deploy`, which owns it (ADR-0027).
- **The import is skipped when the services already exist**, because re-applying a
  `startWithoutCode: true` document at a service carrying code activates an EMPTY app version and
  demotes the running one to `BACKUP`. A PARTIAL set is refused rather than completed: an import
  applies as one document and cannot skip the services that are already there. A service still reading
  `NEW` is refused too — see the 08-10 section above. This describes fresh `platform install`; the
  source-only `platform init` upgrade below uses a dedicated one-service document and does not re-import
  an existing runtime.
- **Every process the import returns is waited on before anything is read or written**, because a
  service holds no environment at all until it leaves `NEW`.
- **Generated secrets are written blind.** They are never read back for comparison, so the command
  cannot tell a correct value from a stale one — which is why it refuses a project that already carries
  those KEYS instead of writing over them. A second bring-up would roll a new vault KEK (unrecoverable)
  and new signing keys (every live token invalid).

It places seven generated values — IAM's ES256 signing keys, the IAM RPC key, the source RPC key, the
proxy key, the provisioning key, the Operations sync key and the control vault KEK — plus one minted on
the account: a Zerops INTEGRATION token (`POST /client/{id}/integration-token`, client role
`NO_ACCESS`, `ADMIN` on this project only), so the installation never holds the personal token the
operator authenticated with. The source key is written under different names on source and control but
has one value. Exactly one value is printed: the provisioning key, once, at the end, because it lives
nowhere else and `platform init` asks for it.

GitHub source configuration is optional at fresh install. `GITHUB_APP_ID` and
`GITHUB_APP_PRIVATE_KEY` must be supplied together and are written only to source; without them public
repositories still deploy anonymously. `GITHUB_WEBHOOK_SECRET` is independently optional and is
written only to control. Source gets neither the Zerops integration token nor any GitHub API-base
setting.

**Partly unverified against a real account.** The import step's behaviour is measured (08-10 section
above) and the command is written against it. Everything after it is not: in particular
`createIntegrationToken`, whose every runtime behaviour is unmeasured (`provider-zerops/src/api.ts`) —
whether client `NO_ACCESS` beside a project `ADMIN` grant is even accepted, and what the minted value
looks like — and the two passes as a whole.

### `fabrika platform init --provider=zerops` source upgrade

Interactive `platform init` is also the supported upgrade/configuration path for an existing
installation. After a separate operator confirmation, it reads the project and imports only `source`
when that service is missing. The import is a source-only services document with
`startWithoutCode: true`; init waits for each exact process id returned by Zerops before reading or
writing the service. Existing platform services and their app versions are not re-imported.

The command then reconciles the shared RPC key directly in Zerops:

- equal valid keys on source and control are reused;
- if exactly one side has a valid key and the other key is absent, that value repairs the absent side;
- if neither side has a key, init generates one and writes both sides;
- an invalid value or two different values is refused rather than rotated.

The one-sided rule makes a retry safe after the first of the two environment writes succeeds and the
second fails. Optional App id/private key and webhook inputs follow the same ownership as fresh install.
Omitting them preserves existing values. None of these source credentials is written to the sidecar
checkout, repository or GitHub Environment; the sidecar still receives only the Zerops integration
token and IAM provisioning key it already needs for deploy.

**Not yet verified live.** The source-only import, one-sided key repair and optional credential writes
are covered by the local installation suite, including a fail-after-first-write rerun. They have not
yet been run against `fabrika-install-test`.

## Fabrika placement mapping

The Fabrika platform project contains:

- `iam`, `operations`, `source`, `control`, and the only public `proxy` runtime;
- one shared `db` PostgreSQL service for IAM and control;
- a separate `operationsdb` PostgreSQL service for Operations;
- private `storage` for run logs and `operationsstorage` for raw events and
  source maps.

IAM, Operations, source, proxy, and control deploy in that order. Source is private, installs `git`,
and accepts authenticated source RPC on port 3000; it has no Zerops token. Operations uses
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
