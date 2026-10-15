# @fabrika/control

The control plane: registry + queue + encrypted vault, driving a deploy from a GitHub push, a manual
trigger, or a repo poll. It runs on **two** targets — a Cloudflare `WorkerEntrypoint` and a long-running
Bun process — from one shared body of code. Assumes the root CLAUDE.md.

The public `ControlRpcContract`, its DTOs, `RunLogLine`, and the console vocabulary (`CONTROL_APP_ID`,
`CONTROL_ACTIONS`, `CONTROL_SCOPES`) live in `@fabrika/control-contract`.
Keep browser and runner consumers on that package instead of importing this
runtime package.

## Commands (this package)

```bash
bun run dev                                       # lopata dev on :18291 (needs packages/iam's `bun run dev` for the IAM binding)
bunx wrangler d1 migrations apply DB --local      # apply migrations to the local D1
bun run oblaka                                     # regenerate wrangler.jsonc (plan/dry)
bun run bootstrap                                  # deploy fabrika itself (needs real CF creds + env)
bun run seed                                       # register apps (single-account: no account registry)

# The Bun/Postgres target (see zerops.yaml)
bun run migrate:postgres                           # apply migrations-postgres/ (FABRIKA_CONTROL_DATABASE_URL)
bun run serve                                      # the long-running server (src/zerops/server.ts)
bun run maintenance                                # the cron one-shot: repo poll + stale-run sweep
```

Migration commands and the Postgres-backed test setup are in [`DATABASE.md`](./DATABASE.md).

`wrangler.jsonc` is auto-generated from `oblaka.ts` — DO NOT edit it by hand.

## Two entrypoints, one body of code

|              | Cloudflare                                     | Bun process (Zerops)                                                  |
| ------------ | ---------------------------------------------- | --------------------------------------------------------------------- |
| entrypoint   | `src/index.ts` (`cloudflare:workers`)          | `src/zerops/server.ts` (`Bun.serve`)                                  |
| HTTP         | `fetch()` → `controlApp`                       | `@fabrika/app/bun` → `controlApp`                                     |
| job consumer | `queue()` → `runControlJob`                    | `PostgresJobConsumer` → `runControlJob`                               |
| cron         | `scheduled()` → `runMaintenance`               | `run.crontab` → `src/zerops/cron.ts` → `runMaintenance`               |
| migrations   | `wrangler d1 migrations apply` (`migrations/`) | `run.initCommands` → `src/zerops/migrate.ts` (`migrations-postgres/`) |
| provider     | `@fabrika/provider-cloudflare` + `RUNNER_SVC`  | `@fabrika/provider-zerops`, deploying in-process                      |

The shared layer is `app.ts` · `consumer.ts` · `cron.ts` · `services.ts` and everything they reach.
It imports only `@fabrika/provider-contract`. `src/index.ts` statically selects Cloudflare;
`src/zerops/provider.ts` statically selects Zerops. `entrypoint-isolation.test.ts` proves that neither
entrypoint reaches the other provider or runtime.

## Architecture

`fetch` routes: `/api/health` → ok · `POST /webhooks/github/:connectionId` → webhook, verified with that
one connection's vault secret (ADR-0029); any other `/webhooks/*` path is a 404 ·
`/iam/admin/*` → transport-only IAM gateway · `/operations/api/rpc` →
transport-only Operations RPC gateway · `/api/rpc` → ACL-gated control RPC surface.
Unmatched `/api` and `/operations/api` paths return 404; they never reach dashboard `ASSETS`.
Other paths fall back to `ASSETS`. `/healthz` is a liveness-only route on
the shared app and is exposed by both the Cloudflare and Bun compositions.
Neither gateway changes service ownership;
IAM and Operations authenticate, authorize, and audit their own requests. Both preserve the browser's
`Origin`; the Operations gateway preserves the proxy-injected token, while the IAM gateway translates
that trusted token to `Authorization` and removes every console cookie before the private hop. IAM
verifies the signed calling-app audience and resolves IAM permissions live. Rewriting `Origin` to the
private upstream's address is exactly the bug that answered 403 to the console's whole Access plane:
the browser's origin is the console's, never the upstream's, so no rewriting scheme could make an
issuer comparison correct. Control reads no `Origin`: the confused-deputy defense is the proxy's session
admission (ADR-0022). A session's state change on any credentialed row reaches Control only with
`Sec-Fetch-Site: same-origin`; a cross-site or same-site one is refused before Control is asked. A bearer —
with a cookie or without — is explicit authority, which no page attaches by itself, so it is admitted
without that header. `src/__tests__/console-admission.test.ts` drives every mount, the GitHub mutations and
the approvals through the real proxy. Never add a same-origin check here. Admission is not enforcement and
not authorization (`docs/reference/overview.md` names all three). `controlPublicOrigin` remains the
configured public origin, which the GitHub App manifest's callback is built from. A trigger
writes a `pending` run to the
database then enqueues. ONE queue (`DEPLOY_QUEUE`) carries both kinds of work — deploy jobs and
namespace provisioning jobs — as a discriminated union; a payload with no `kind` is a deploy job.
The consumer resolves the statically selected `ControlProvider` and calls its
capabilities. Cloudflare hands the provider-owned job to vozka-runner. Zerops runs the
whole deploy in process. Core owns registry/run writes, locking, secret resolution, and generic envelopes.

Runtime surface: `src/env.ts` (ports + vars) · `src/platform-cf.ts` (the raw CF bindings + their
adapters) · `src/services.ts` (how every dependency bag is built). Persistence capabilities live in
`src/db.ts`; the runtime composition root assembles them over D1 or Postgres. Schema:
`migrations/*.sql` (SQLite/D1) and `migrations-postgres/*.sql` (the same schema for Postgres).

Three deploy TRIGGERS, all converging on the same `createRun` + enqueue: (1) the GitHub-App push
webhook (`src/github/triggers/webhook.ts`, private repos, scoped to one connection); (2) the manual Deploy button (`triggerDeploy`); (3) the cron
poller (`src/github/triggers/poll.ts`, wired in `scheduled`) for PUBLIC repos with no App install — it conditional-
GETs the repo's commits/tags Atom feed (ETag) and enqueues on a new head sha (`runs.trigger='poll'`).

An env's `trigger_ref` is an exact git ref OR a `*`-GLOB (`src/ref-match.ts` `refMatches`), most usefully
`refs/tags/v*` to deploy on every version tag. The DEPLOYED ref is always concrete — the pushed ref
(webhook) or the resolved newest matching tag (poll) — never the pattern. NULL trigger_ref = manual-only;
a glob trigger_ref falls back to the default branch for a no-ref manual deploy. An app's environments hold
DISTINCT trigger refs (`idx_app_envs_trigger`): `apps.environments.put` refuses a taken one with a 409 that names the
other environment, before the provider prepares anything, and the write maps a racing put's index violation to
`AppEnvTriggerRefConflictError`.

## Invariants

- **Administrative operations use `/api/rpc` only.** `controlApp` authenticates once in `controlAuthenticator`
  (`src/iam.ts`); `src/control-rpc.ts` applies `.require()` with the action/scope. Run/deploy use cases
  resolve coordinates before checking permissions and hide denied resources as 404. Actions/scopes
  live in `@fabrika/control-contract` (`src/access.ts`). Keep webhook, health, and GitHub browser protocols as
  HTTP routes.
  `runs.tail` is cursor-based RPC polling, not a separate streaming endpoint.
- **`consoleAccess` is information, not a decision** (`src/console-access.ts`). It answers any caller the console
  vocabulary it holds — global actions and actions per `app` or `environment` value, in the caller document's shape
  (ADR-0022 rule 5) — read through `can()` and `scopedTo()` only, so the bootstrap admin reads as holding every
  action. The console shows and hides by it; every procedure still checks its own action. The vocabulary is
  `controlSchema.actions` (`fabrika.schema.ts`), so an action added there is reported without a change here. It
  answers nothing about IAM: what a caller administers there, the installation or the people of applications
  (ADR-0058), the console reads from IAM's `me` through the IAM gateway. The console's own vocabulary is not where
  IAM's authority lives — never add an `iam.*` action to `controlSchema`.
- **The PROXY is the front door; `src/iam.ts` only verifies (ADR-0022).** The proxy decides from the
  console's service table (`fabrika.service.ts`), resolves the credential, and injects the access token as
  `X-Fabrika-Token` and the selected row as `X-Fabrika-Endpoint`.
  `iam.authenticate(request)` re-verifies that token LOCALLY against IAM's JWKS — signature, `iss`,
  `aud`, `exp` — and builds the `AuthContext` for `can(action, scope?)` + audit. Nothing here makes an
  enforcement decision, exchanges a session, or writes a cookie, and a miss is a flat 401/403/503, never a login
  bounce (only `src/iam-admin.ts` / `src/operations-gateway.ts` attach a `loginUrl`, and theirs comes
  from an UPSTREAM 401). `env.IAM` is the `IamRpc` CONTRACT, so it is a service binding on Cloudflare
  and `HttpIamRpc` (`@fabrika/auth`, bearer `FABRIKA_IAM_RPC_KEY` against IAM's `/rpc/*` at the private
  `FABRIKA_IAM_RPC_URL`) in a process. `FABRIKA_IAM_ISSUER` remains the public issuer. ONE `HttpIamRpc` per
  process, never per request: the SDK caches the JWKS in a WeakMap keyed by that object.
- **`fabrika.service.ts` is the service contract** (ADR-0022 "Installation entries"):
  `controlServiceContract({ mcp })`, exported as `@fabrika/control/service` with the MCP constants. The proxy
  publishes it through `serviceProxyTable`, and `createControlApp` (`src/app.ts`) serves every row by id with
  `serveService`: a `service` row the proxy did not name in `X-Fabrika-Endpoint` answers 503. Its `*-root` rows
  and the reserved `/webhooks` and `/mcp` keep every path the service answers 404 away from the SPA; with
  `mcp: false`, `/mcp` is a session-only 404 row. The module stays free of the provider and of `src/`, so
  `@fabrika/local-stack` imports it into a strict program.
- **ONE MCP switch: the digest of the table the proxy publishes.** The composition writes
  `FABRIKA_SERVICE_TABLE_DIGEST` (`installationTableDigest`) beside the Zerops process from the same manifest
  the proxy gets; `createRuntime` reads it through `controlMcpSwitch` and refuses to start when it is missing or
  names neither console table. With MCP on, `FABRIKA_CONTROL_DOMAIN` is required too. The Cloudflare Worker has
  no MCP route: it serves `controlApp` (`mcp: false`), and `fabrika.config.ts` builds its proxy from the same
  table.
- **ONE auth path, locally included — there is no `DEV` var any more.** `env.IAM` and
  `FABRIKA_IAM_ISSUER` are required in every environment; `createIam` refuses to build without them, and
  `fabrika.config.ts` binds IAM locally for the same reason (the proxy Worker in front already did).
  The synthetic `DEV` persona roster this Worker used to pass to the SDK — selected by an
  `X-Dev-Principal` header or a cookie, defaulting to a global admin — was a SECOND authentication
  model that verified nothing, and it is deleted. Local development runs the real stack, where IAM
  signs the operator in through its own `LOCAL_DEV_LOGIN`; to exercise a non-admin role locally,
  grant a real principal in IAM rather than reintroducing a persona.
  `FABRIKA_CONTROL_BOOTSTRAP_ADMINS` is the ONLY escape hatch here and fails CLOSED on a malformed
  value. There is no machine twin: `FABRIKA_IAM_PROVISIONING_KEY` authenticates against IAM's own
  `/admin/*` surface and has no `credentials` row, so behind the proxy `mintFromKey` answers
  `invalid_key` and the request never reaches this Worker. Machine access to `/api/*` is an
  IAM-ISSUED SERVICE KEY, which is a real credential the proxy can exchange
  (`docs/reference/human-authentication.md`).
- **`ENVIRONMENT=local` IS REFUSED WHEN `FABRIKA_CONTROL_DOMAIN` IS NOT A LOOPBACK ORIGIN**
  (`readEnvironmentName`, `@fabrika/auth-core`; both roots — `zerops/runtime.ts` at boot and
  `controlEnv` on the Worker's first request). Control does not branch on the name today, which is
  exactly why it must not drift: on `fabrika-test` it carried `local` while serving a public
  `.zerops.app` host (backlog 59), so the next `=== 'local'` branch would inherit an installation
  already claiming to be a laptop. The origin is read through `controlPublicOrigin`, so a bare host and
  a full origin mean the same thing; stating no origin is supported and means no claim.
- **Vault (`src/vault.ts`): envelope AES-256-GCM**, KEK from `FABRIKA_CONTROL_VAULT_KEY` (never in D1, never logged).
  Secret VALUES are write-only over the API; D1 stores only ciphertext + wrapped DEK. Losing the KEK is unrecoverable by design.
- **GitHub sources are one model on both clouds (`src/github/`, ADR-0029).** `connections/` holds the connection store,
  the management workflow and the vault-held credentials; `source/` the archive, transport and metadata; `triggers/`
  the push webhook and the public-repo poll. Each connection's App id and key
  are a platform vault entry (`platform:github-source:<id>:app-credential`), written in the callback's
  checkpoint transaction and read per operation; nothing caches them, and no App key is a Worker secret or
  env var. Both compositions manage connections from the console (`createSourceConnections`) and mint
  repository tokens with `vaultGitHubCredentials`. A private operation names `(connectionId,
  installationId)` and never falls back to another connection. A registration without a connection is an anonymous
  source: `register` probes it once through `CommitSource.anonymousReadability` (`HEAD`, no token) and refuses a 404
  with 409, so a private repository is not found only at deploy as `ref_not_found`; an inconclusive probe registers. Origins are fixed; seams come only from code
  (the local stack's `control-server.ts`, tests), never from env. `source/archive.ts`, `source/repository.ts`,
  `source/transport.ts` are process-only; the Worker and the shared layer reach `connections/port.ts`,
  `connections/credentials.ts`, and `source/metadata.ts`. On Cloudflare `cloudflareGitHubSource` (`src/platform-cf.ts`) resolves the commit and
  builds the runner's clone URL with a repository-scoped token as `x-access-token`. Every gzip stage goes through `pullThrough` (`src/github/source/streams.ts`):
  Bun's compression streams ignore backpressure, and `pipeThrough` would buffer a whole repository.
  A platform archive may carry ONE generated data file (`SourceDataFile`, the Zerops proxy manifest, ADR-0045),
  appended after every entry of the commit; a commit that holds its path is refused, and the upload reports its sha256.
- **App secrets are vault-only** (`src/secret-resolver.ts`, D4). `apps.secrets.put` and `vault.set` take the
  plaintext VALUE and seal it (or hand it to a provider that manages secrets itself); no API accepts a ref.
  The resolver knows only `vault:`; any other stored ref — a row from before this rule — THROWS rather than
  deploy with a wrong or empty credential, and is never migrated. It handles ONLY per-app `pipeline.secrets`;
  platform creds are fabrika's own Worker config.
- **A `vault:` ref is OWNED by the app secret that minted it.** The vault is one table shared with every
  other app and with `scope='platform'` rows, and `app_secrets.value_ref` is the only pointer into it — so no
  API accepts a ref (a value that looks like one is just sealed), and every path that FOLLOWS a
  stored one — resolve, rotate, delete, and the prior-ref delete inside `vault.set` — goes through
  `getSecretForPurpose` with `appSecretPurpose(app, env, name)` (`src/secret-resolver.ts`), the same
  `{scope,label}` the value was sealed under. A mismatch is a 403 that names neither, and changes nothing.
  There is no AAD on the envelope, so the row's own scope+label is the whole ownership record; do not add a
  second way to address a vault row.
- **The platform's own environment names are refused on the SECRET surface too**, not only on `vars`:
  `assertUnmanagedName` (`src/api/registry/validation.ts`) guards `apps.secrets.put`, `vault.set` and `vault.rotate`
  against `FRAMEWORK_VARIABLE_NAMES` (`@fabrika/auth-core`, the one list the providers refuse too), and
  `executeDeploy` re-checks the resolved secret names beside the variable names, before any provider effect.
  A Zerops managed-secret write reaches the live service at REQUEST time, so the API check is the only one
  that runs in time there.
- **A variable value is one bounded line and a domain is a literal host.** `assertAppVarValue` (4096 chars;
  no C0/C1 control, DEL, NEL, LS or PS — the line breaks a YAML 1.1 reader honours, not only `\n`) and
  `assertProxyDomain` (`isProxyHost`) refuse invalid RPC/domain input. The variable bound is the belt;
  the Zerops emitter's own escaping of those code points is the braces.
- **One static provider per installation.** Core persists versioned target/artifact envelopes and calls
  `ControlProvider`; it has no provider registry and no provider-id branch. Cloudflare credentials live
  only in `WorkerBindings`; Zerops credentials live only in the process composition. Provider packages
  validate envelopes and own deploy, cancel, reconcile, and provider-managed secret behavior.
- **Operations projection is asynchronous with respect to registry and deploy
  success.** Control owns application/environment and deploy-run coordinates,
  persists desired catalog/release revisions, and replays them after Operations
  downtime. It assembles reserved `FABRIKA_OPERATIONS_DSN` and
  `FABRIKA_RELEASE` values for every provider deploy; app-authored collisions
  fail before provider effects.
- **`app_envs.public_origin` is explicit observation configuration, not provider
  routing.** It is a canonical HTTP(S) origin, remains independent of `domain`,
  and is projected unchanged to Operations. `apps.environments.put` omission preserves the stored
  value; explicit `null` clears it. Never derive it from a provider hostname.
- **The same column is also what IAM trusts as a return origin (ADR-0022).**
  `projectedReturnOrigins` (`src/return-origins.ts`) reads it from the DEPLOYING
  environment only and hands it to the provider on `deploy` and on `reconcile`; the
  deploy's existing IAM touchpoint (`reconcileSchema`) writes it under the IAM
  application id `<app>@<env>` (ADR-0022 rule 6). Never collect another environment's
  origin: registered under `notes@prod`, a `stage` host would be handed production
  sessions. No origin → the field is ABSENT, not
  empty: fabrika leaves an environment it has no address for unregistered rather than guessing,
  and an empty set would read as "clear the registry". Nothing else here calls IAM's
  admin surface per deploy; do not add a second lifecycle for this.
- **A namespace proxy authenticates itself to each application with a proxy secret (ADR-0022 rule 5).**
  `src/proxy-secret.ts` generates it the first time an environment is handed to a namespace (a republish's
  members, or a deploy's `FABRIKA_PROXY_SECRET`), seals it in the vault under
  `proxySecretPurpose(app, env)`, and records only the ref in `app_env_proxy_secrets`; a lost insert race
  deletes its own vault row and answers the recorded one. Every follow goes through
  `getSecretForPurpose`, like an app secret. Without a vault no secret is handed out and the provider
  refuses a contract application. There is no rotation verb; `FABRIKA_PROXY_SECRET` is a reserved name.
- **A namespace member carries `operationsOrigin`, the origin of its active ingest DSN** (`namespaceMembers` in
  `src/api/namespaces.ts`), so a Zerops proxy's header policy admits the same Operations origin the framework
  does. The DSN carries the ingest key; only its origin leaves Control this way.
- **A job's and a webhook's key come from the APPROVED contract (`src/workload-credentials.ts`, ADR-0022 "Principal
  kinds").** `executeDeploy` reconciles one key per job and per webhook declaration of
  `registration.environment.access.contract` before the provider runs (never on a dry run): a recorded key with more
  than half its 30 days left is read back from the vault, otherwise IAM's `workloads.issueKey` issues a new one with
  the provisioning key (`iamWorkloadKeyIssuer`, at `FABRIKA_IAM_ISSUER`), sealed under
  `workloadKeyPurpose(app, env, kind, name)` and recorded in `app_env_workload_credentials` (vault ref, IAM's
  credential id and expiry). Every issuance names the recorded credential as `keep`, so IAM never revokes the key
  the running version holds; a key issued by a deploy whose record failed is revoked by the next issuance, and its
  vault row is deleted at once. A removed workload's record and vault row are deleted. Each key is handed as `FABRIKA_<KIND>_<NAME>_KEY` and redacted
  from the run log. Two workloads whose names map to one variable are refused. Without a vault, an issuer or a
  provisioning key a contract with a workload fails the run. What a key may do is IAM's: the schema reconcile
  declares the actions. An environment not deployed for 30 days loses its workloads' keys.
- **The membership transport key comes from the APPROVED contract too (`src/membership-transport.ts`, ADR-0022
  rule 6).** Behind a namespace proxy an application has no IAM binding, so while `needsMembershipTransport` holds for
  the approved contract (an endpoint with a delegation, one on, in or below a dimension with members, or a share-link
  mount) `executeDeploy` reconciles one key per
  environment the same way: read back while more than half its 30 days are left, otherwise IAM's
  `membershipKeys.issue` with `keep`, sealed under `membershipKeyPurpose(app, env)` and recorded in
  `app_env_membership_keys`. It hands `FABRIKA_IAM_RPC_URL` (`FABRIKA_IAM_ISSUER`) and `FABRIKA_IAM_RPC_KEY`, both
  null otherwise, and redacts the key. In the application that variable is this key, never the installation's RPC
  key. Without need the record and vault row go; IAM deletes the key with the reconcile. The key adds no authority.
- **A consumer's connector keys come from the APPROVED contract too, and an edge Control would break is refused**
  (`src/connectors.ts`, ADR-0022 "Principal kinds"). The same reconcile issues one `app` key per owner application
  the contract imports from, at `<owner>@<env>` naming the consumer, recorded as kind `app` named by the owner
  (`declaredConnectors`), and hands it under each import's `FABRIKA_CONNECT_<IMPORT>_KEY`; `connectorAddresses`
  adds the owner environment's `https://<domain>` as `_URL` and fails a deploy whose owner has none. When the last
  import of an owner goes, IAM's `workloads.revokeKeys` revokes every key of the pair (the owner still declares the
  consumer, so its schema reconcile would not) before the record and vault row are deleted; a failed revocation
  fails the deploy and keeps the record. A consumer import of a procedure the owner's export lacks is refused. Publication
  (`assertConnectorEdges` in `src/approval/publish.ts`) runs before classification and fails the run, approved or
  not, when a consumer's import is not exactly the owner's approved export of the same environment
  (`consumerEdgeProblems`), or when an owner's candidate breaks an approved consumer's import
  (`ownerEdgeProblems`, the rule in `incompatibleChanges`). The two sides publish independently, so two
  concurrent publications can each pass against the other's previous snapshot; the next deploy of either sees
  the break. `connectors.describe` answers the approved export to its consumer for `fabrika connect`, behind
  `deploy.read` on the consumer, and the same 404 for anything else.
- **No authored value may copy a framework-only variable, and no run log keeps a secret Control handed out.**
  `assertNoFrameworkReference` refuses an app variable or secret VALUE that references a
  `FRAMEWORK_VARIABLE_NAMES` name in any Zerops form (`${NAME}`, `${RUNTIME_NAME}`, `${<host>_NAME}`, a
  nested `${…${…}}`; `frameworkVariableReference` in `@fabrika/auth-core`). `RunLogWriter` passes every
  provider line through `redactKnownSecrets` — the run's resolved app secrets and its proxy secret — before
  it prints or stores it, because a provider relays what the application printed.
- **Run lifecycle is status-guarded + idempotent** (`src/run-lifecycle.ts`): `markRunStarted` only moves
  pending→running, so a redelivered queue message is a no-op. ack handled runs; retry only on an unexpected throw.
  A run that fails before the provider accepted it writes `deploy failed: <reason>` to its run log before the row
  turns `failed`: the message only, through `redactNamespaceErrorText` and the run's known secrets, never the error object.
- **Control is the only writer of a run's row (ADR-0044).** A Cloudflare run settles in exactly two ways,
  both under the run's lease: the awaited `startRun` result (`executeDeploy`), or — after a Control
  restart such as a self-deploy — `reconcileProviderRuns`, where the provider's `reconcile` reads the
  status vozka-runner persisted in R2 (`recoverRun`, parsed in `platform-cf.ts`). Either way the provider
  applies the outcome's IAM schema reconcile BEFORE Control marks the run terminal, so a terminal row is
  never re-opened. An invalid report fails the run; on the reconcile path an IAM failure keeps it
  `running` for the next cron, with the reason appended to the run log (`runLogs`). IAM replaces the
  app's whole vocabulary, so a re-application after a lost lease is harmless. A redelivery or a second
  reconcile finds the row terminal and applies nothing. A dry status is projected dry and applies nothing.
- **The Cloudflare provider owns the runner boundary.** `CloudflareRunnerJob` and its validator live in
  `@fabrika/provider-cloudflare`; its oblaka-free `./runner` entry also carries the transport schemas, types and
  endpoint constants, `@fabrika/runner-container` owns the Bun process and image, and
  `@fabrika/runner-cloudflare` owns the executor Worker.
  The control plane has NO `Container` binding. The split exists because a deploy's final
  step runs `wrangler deploy` INSIDE the container, and when the target is fabrika that resets fabrika's DOs —
  so a container hosted in fabrika would reset ITSELF mid-deploy. Hosting it in vozka-runner means a fabrika
  deploy never touches it. As a consequence fabrika has no `Container` → no docker → it's deployable THROUGH
  the runner. vozka-runner writes only R2 (logs and the terminal `status.json`), never the database.
  vozka-runner is deployed out-of-band (its own bootstrap).
- **Per-app-env deploy lock** (`@fabrika/platform`'s `SqlDeployLocks`, wired in `src/services.ts`; one
  `deploy_locks` ROW per `<app>:<env>`, NOT a DO — the implementation needs nothing but the `SqlDatabase`
  port, so it is portable and lives with the ports, not in this Worker):
  `executeDeploy` takes it before starting and releases it in `finally`, so two triggers can't deploy the
  same target concurrently (race on cf-state / wrangler / IAM). A contended run returns `deferred` —
  left `pending` and re-enqueued by the consumer with a delay (a fresh delivery, so the retry budget is
  preserved). The lease is non-reentrant + TTL-bounded (self-heals if a consumer dies) + holder-checked on
  release; `acquire` is ONE conditional upsert (`meta.changes` is the answer) so there is no read-then-write
  race, which is why it works identically on SQLite and Postgres. Never split it into a read + a write.
  Invocation ownership is ONE lease primitive (`src/lease.ts`, ADR-0044): a unique holder, a 90 s TTL
  renewed every 30 s, and every run write holder-fenced (`LeaseFence`; the lease row stays locked in the
  same batch, because an `EXISTS` alone races takeover on Postgres). `requestRunCancellation` is the ONE
  unfenced run update — it records a request, and the holder reads it at step boundaries
  (`RunInvocation.boundary()`, and providers through `events.boundary()`), never by polling the row. The
  Operations catalog sync holds the same lease (`CATALOG_LEASE_KEY`) and fences its one data write,
  `markApplied`, the same way; terminal release repair holds none,
  because its revision predicate already makes an overlapping replay a no-op. On SIGTERM the Bun process
  takes no new catalog lease and, after a 10 s grace, interrupts a flush still running and releases its
  lease (`stopControlServer`), so the process a rolling deploy replaces leaves no lease to wait out. Every
  catalog lease release is bounded at 5 s and the pool closure at 2 s (`shutdownProcess`), so a stalled
  release query cannot hold up the shutdown.
  Preserve unresolved running rows after lease release: they exclude later deployments until recovery
  settles external work — the next deploy of the environment settles one inline under its own lease
  (`settleUnfinishedRun`, the same body as the cron's reconcile) and defers only while it stays unsettled.
  Lease loss must never become external cancellation or terminal failure.
  A settled cancellation finishes the run with the provider's `outcome`: when activation won first the
  run SUCCEEDS — cancellation never implies rollback (ADR-0044). Control hands every cancel and
  reconcile the run start (`startedAtMs`, from `started_at ?? created_at`) so a provider can bound its polling.
- **Namespace provisioning is a JOB, not a request** (`src/api/namespaces.ts`, backlog 74). `create` /
  `adopt` / `reconcile` persist the row `pending`, enqueue, audit and return; the worker claims
  `pending`→`provisioning`, runs the provider mutation with its OWN signal, and records `ready`/`failed`.
  The job holds a `namespace:<id>` lease in the same `deploy_locks` table, on the same TTL — a namespace
  left `provisioning` is deliberately RESUMABLE, so unlike a run
  nothing else refuses a redelivery and the renewed lease is the only guard against one.
  `reconcile` on a namespace that is still settling moves its STATE back to `pending` and enqueues; it
  must never rewrite `provider_target_json`, or a checkpoint the running job just wrote is rolled back
  under it. Only a job's claim moves a `pending` row, so the running job leaves it `pending` and the
  queued job runs after it.
- **A failure keeps its CLASS, redacted rather than discarded** (backlog 72). A provider raises
  `ProviderNamespaceError` (stable `code`, safe summary, the upstream's words in `detail`); core stores
  `<code>: <message>` in the one `last_error` column — redacted and bounded — and projects the two halves
  as `lastErrorCode` + `lastError`. The FULL cause is logged, redacted the same way and UNcapped. An
  untyped throw is `internal`. Core's own checkpoint invariants carry core's `checkpointInvariant` code,
  never a provider's vocabulary. Never store or log the error OBJECT.
- **The namespace proxy FOLLOWS the registry.** The proxy manifest, not the registry, is the live
  authorization state (ADR-0022). Every rebuild goes through core `republishNamespace` /
  `republishUnderLease` (`src/api/namespaces.ts`), which holds the `namespace:<id>` lease, hands the
  provider's optional `namespaces.republish` capability the members read under it, writes every
  checkpoint fenced (`writeDeploymentNamespace`), and leaves a rebuild it did not see go live
  `provisioning` with a `reconcile` job queued (ADR-0044). Three callers: `executeDeploy` takes the
  namespace lease AFTER the run lease (lock order is always app/env → namespace; a namespace path never
  takes an app/env lease), defers when it is busy, republishes with `wait: 'active'` and releases it
  before `provider.deploy`; `deleteApp`, `deleteAppEnv`, a changed `domain` and a changed namespace
  assignment await `namespaceProxyChanged`, wired in `buildControlRpcDeps` only when the provider declares
  `republish`; and `namespaces.reconcile` republishes a `ready` namespace as the operator's repair verb.
  The registry hook waits for the manifest to PUBLISH and the roll to start (`wait: 'started'`), not
  for the build — a proxy build takes minutes and this runs inside a request. Every affected namespace is
  attempted before anything is reported; a republish failure is a 502 that LEAVES the registry change in
  place (the row is already the truth), and `reconcile` still queues the provider mutation when its own
  republish fails. Never log the IAM key or the manifest.
  **A CLAIMED environment is refused, not deleted**: `namespace_resource_claims (owner_app_id, owner_env)`
  is `ON DELETE RESTRICT` and every Zerops app env acquires claims, so `deleteApp` / `deleteAppEnv` READ the
  held claims first and answer 409 naming each namespace and its resource keys — before the row is touched,
  audited, or the hook runs. The republish is therefore reachable only for an environment holding no claims
  until claim release is decided — releasing them is a USER decision, not a fix: fabrika deletes no provider
  resource (ADR-0034), so a freed name makes an orphaned service adoptable by the next app, carrying its old
  secrets.
- **`namespaces.update` runs in the request, not behind the queue** (backlog 79). The provider PLANS the
  merged target first (pure; an unknown field → 400; `PROVIDER_NAMESPACE_IMMUTABLE` → 409 naming a new
  namespace id, because removal keeps the provider project and recreating the id adopts it). Then, under the
  `namespace:<id>` lease (`registry.namespaceLocks()`, the same `deploy_locks` table the fenced writes check),
  the row is MARKED before the provider APPLIES: `failed`, `namespaceUpdateUnconfirmed`, and the planned
  target in `update_target_json` (the mark itself; `isUnconfirmedNamespaceUpdate`). Every write is
  `transitionDeploymentNamespace`: fenced and compare-and-set on `state` + `last_error`. Success → new target
  - `ready`; a definite failure → the row restored; unconfirmed → the mark stays, and only a retried update
    clears it. The row states have a CHECK constraint, which is why the mark reuses `failed` rather than a new
    state. Removal refuses a marked row IN SQL; `requeueDeploymentNamespace` keeps its state and sets
    `repair_requested` instead, and the clearing write lands `pending` and queues the reconcile, so a proxy
    repair asked for during an update is replayed, never dropped. A marked namespace REFUSES deploys
    (`providerEnvironment`) and republishes (`republishUnderLease`), naming the retry: a republish writes
    `provisioning` → `ready` and would erase the mark. This replaces the old sprint's "usable while marked".
    A proxy source re-pin (plan change `proxySource`, ADR-0045) is the one update a `failed` namespace accepts; it
    stores the target `pending` and queues the reconcile that rebuilds the proxy.
- **Removal is the narrow case only** (backlog 73). `namespaces.remove` frees a namespace with no
  registered app environment that no worker is settling; it deletes the row and its resource claims in ONE
  guarded transaction (claims first — both FKs are `ON DELETE RESTRICT`) and frees the id for reuse, which
  is the id the provider's own marker recovery is keyed to. It deletes NO provider resource (ADR-0034) and
  answers with the row the DELETE returned, so the operator is told what is now unowned.
- **MCP authoring is a Bun-only protocol adapter (ADR-0049).** `src/zerops/server.ts` routes
  `POST|GET|DELETE /mcp` to `src/mcp/handler.ts`; everything else reaches `controlApp`. The Worker graph
  never imports the MCP SDK (`entrypoint-isolation.test.ts`). `/mcp` verifies the injected token for the
  resource profile `controlMcpResource(controlPublicOrigin)` only, requires `AuthContext.oauth` and a
  user, and never applies the bootstrap-admin hatch. The tools call `src/api/workspaces.ts`, which reaches
  the repository through the `WorkspaceSourcePort` — `src/github/workspace.ts`, the binding's own GitHub
  App with its key read from the vault per operation. A workspace is the branch `fabrika/<id>` owned by one
  principal; every use case re-checks `app_envs.authoring`, the action at the coordinates and ownership, and
  answers 404 otherwise. Paths are repository-relative (`isRepositoryPath`, at the MCP boundary), and
  protected paths (`zerops.y[a]ml`, every `fabrika.*` but the exact `fabrika.contract.ts`, everything under
  `.github/`) are refused before GitHub is called. `get_deployment` reaches only runs of the caller's own
  workspace branches, and reports a parked run with its approval link and every run's `deviations` (its lines that
  need closer review). `get_app_rules`
  answers the body of `@fabrika/app`'s `skill/SKILL.md`; the server `instructions` stay under 2,000
  characters (some clients cut them at 2 KB) and point to it. Never restate the rules beyond those three lines.
  One authoring environment per app: `apps.environments.put` answers 409 while another env holds the flag.
- **Published access comes ONLY from `approvedSnapshot(app, env)` (ADR-0050, `src/approval/`).** Right after the
  commit is pinned, `executeDeploy` reads the run's snapshot (`readAccessSnapshot` over `env.COMMITS`, the
  commit's tree and files through the GitHub metadata client; `contractReaderInputs` names the files), stores it
  on the run, classifies it against the active snapshot (`classifyAccess`, pure, conservative) and either parks
  the run in `awaiting_approval` (a widening on a `protected` environment without a matching approval) or
  publishes it with `publishRunSnapshot`, a compare-and-swap on `app_envs.generation` and `protection_revision`
  fenced on the run lease and taken under the namespace lease; a lost swap classifies again. The snapshot is read
  at `provider.applicationRoot(source)`, the provider's own normalization of `workerDir`. `providerEnvironment` and
  `namespaceMembers` attach `approvedProviderAccess`, so every deploy, cancel, reconcile, registry hook and
  namespace job hands the provider the approved access and nothing else: `access`, the approved contract. A commit
  without `fabrika.contract.ts` fails its run with `ContractMissing` before the provider is called, and publishes
  nothing. A stored snapshot's legacy `artifact` field is dropped when it parses, and a publication without a contract
  reads as the empty baseline (`approvedSnapshot`). `runs.pending_access_json` is no longer read or written. The
  published snapshot lives in `app_envs.published_snapshot_json`. Snapshot log lines are codes and counts only. A new write path must take it the same way; reading access
  from the provider artifact is a bug. An approval names both digests and holds only for them.
- **Steps off the paved road are in the reviewed snapshot, never refused by it (`diff.ts`).** Two kinds only: the
  reach a staged-kit site declares (`ContractArtifact.declared`: `sql`, `unscoped`, `connect`, `issues`), and the
  database code the migrations declare (`AccessSnapshot.databaseCode`, from `classifyMigrations` of
  `@fabrika/platform-node/sql`, the runner's own classifier, over every file under `db/migrations/`). A site is keyed by
  its endpoint id or `job:<name>`, a database object by file, kind and object, never by line, so a moved handler is no
  change. A new site, table, connector, mount or object, `read` → `write`, an edited file holding code, and a contract
  that leaves the staged kit widen with `review: 'closer'`; removals narrow. `databaseCode` is absent when empty and
  the digest appends it only when present, so stored digests stay valid. A refused statement in a file the environment
  has not published unchanged fails the read (`migrations-refused`, a count, never the statement), as the runner
  refuses it. Checker structure hints never enter the snapshot. `AppEnvDto.deviations` lists the published snapshot's.
- **Only a person in the console approves (`src/approval/api.ts`).** `approvals.complete` and
  `apps.environments.protect` need `access.approve` at the coordinates (outside `deploy.*`) from a `user`
  principal with no OAuth claims, no link claims and no `Authorization` header (`src/approval/human.ts`); the
  proxy admitted the session's POST from the console itself. The decision is written under the run lease
  (a busy environment answers 409); it is never an unfenced run write. Runs record their actor (`runActor`).
  Deleting a protected environment, or an app with one, takes the same human (`requireHumanForProtectedDelete`,
  over `RegistryUseCaseContext.admission`). The flag and the counters outlive the row in `app_env_protection`; a
  change of the flag bumps `protection_revision` and `generation`, and a registry write bumps `generation`, so an
  in-flight publication loses. Registry put and delete apply only at the generation they read (409 otherwise), and
  every write of an environment takes its coordinate lock first (`DATABASE.md`). `apps.environments.protect` takes
  the environment's deployment lease and answers 409 while a run holds it or is still `running`.
- **Never log a secret/credential** (see root). The run row is written before the queue is touched (durable trigger).
- **`fabrika.config.ts` is the source of truth** for fabrika's own resources; keep `oblaka.ts` a thin shim (see root).

## Patterns

- **Database access, dialect rules, and migrations: read [`DATABASE.md`](./DATABASE.md)** before
  editing `src/db.ts`, `migrations/`, or `migrations-postgres/`. It covers the ADR-0015 repository
  seam, caller-stamped timestamps, the int4-vs-BIGINT row-shape rule, and the ADR-0017 ledger.
- RPC use cases throw structural `ControlApiError` errors (`src/api/domain.ts`); the RPC dispatcher owns
  the response envelope. Protocol routes use `src/http.ts` `error(status, msg)`. Unexpected throws → 500, never leak internals.
  On the Bun target that catch-all is NOT optional: `Bun.serve`'s default error page puts the exception
  AND the surrounding source lines in the response body, so `createFetchHandler` wraps every request and
  `Bun.serve`'s `error()` backstops anything raised outside it. Both answer a bare `internal error`.
- **The generated root `zerops.yaml` is the only platform build specification.**
  `packages/provider-zerops/src/installation/topology/setups.ts` owns the typed IAM, Operations,
  control, and proxy setups; do not add per-package
  `zerops.yaml` files.
