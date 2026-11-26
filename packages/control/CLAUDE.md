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
bun run serve                                      # the long-running server (src/zerops/server.ts → src/bun/server.ts)
bun run maintenance                                # the cron one-shot: repo poll + stale-run sweep
```

Migration commands and the Postgres-backed test setup are in [`DATABASE.md`](./DATABASE.md).

`wrangler.jsonc` is auto-generated from `oblaka.ts` — DO NOT edit it by hand.
Its `migrations` array is the only record of the Durable Object history, and the full list must replay on a fresh
account, where wrangler applies every step from the first tag (deleting a class no earlier step created fails with
10074). `src/__tests__/worker-migrations.test.ts` replays it. One historical repair: when `DeployLock` was removed, its
creating step `v0002 new_sqlite_classes [DeployLock]` was lost; it was restored to match the file's git history, and
oblaka keeps it on regeneration. Existing installations were unaffected: wrangler sends only the steps after the
script's own tag. If a step is lost again, regenerate with `bun run oblaka` from a resource graph that keeps the
history, and ask the owner.

## Two entrypoints, one body of code

|              | Cloudflare                                     | Bun process (Zerops)                                                  |
| ------------ | ---------------------------------------------- | --------------------------------------------------------------------- |
| entrypoint   | `src/index.ts` (`cloudflare:workers`)          | `src/zerops/server.ts` → `src/bun/server.ts` (`Bun.serve`)            |
| HTTP         | `fetch()` → `controlApp`                       | `@fabrika/app/bun` → `controlApp`                                     |
| job consumer | `queue()` → `runControlJob`                    | `PostgresJobConsumer` → `runControlJob`                               |
| cron         | `scheduled()` → `runMaintenance`               | `run.crontab` → `src/zerops/cron.ts` → `runMaintenance`               |
| migrations   | `wrangler d1 migrations apply` (`migrations/`) | `run.initCommands` → `src/zerops/migrate.ts` (`migrations-postgres/`) |
| provider     | `@fabrika/provider-cloudflare` + `RUNNER_SVC`  | `@fabrika/provider-zerops`, deploying in-process                      |

The shared layer is `app.ts` · `consumer.ts` · `cron.ts` · `services.ts` and everything they reach.
It imports only `@fabrika/provider-contract`. `src/index.ts` statically selects Cloudflare. The Bun host
(`src/bun/`: server, runtime, cron, migrate, MCP, the IAM and Operations gateways) takes its provider as a
`BunProviderComposition`; `src/zerops/` holds Zerops' composition (`provider.ts`) and the thin entries
`zerops.yaml` names, and `src/aws/` the AWS provider's, which no installation runs yet. `entrypoint-isolation.test.ts` proves that neither entrypoint reaches the other provider
or runtime, and that the Bun host names no provider.

## Architecture

`fetch` routes: `/api/health` → ok · `POST /webhooks/github/:connectionId` → webhook, verified with that
one connection's vault secret (ADR-0029); any other `/webhooks/*` path is a 404 ·
`/iam/admin/*` → transport-only IAM gateway · `/operations/api/rpc` →
transport-only Operations RPC gateway · `/api/rpc` → ACL-gated control RPC surface.
Unmatched `/api` and `/operations/api` paths return 404; they never reach dashboard `ASSETS`.
Other paths fall back to `ASSETS`: on Cloudflare every request but Vite's bundles under `/assets/` reaches the Worker first
(`run_worker_first`), so the service table, not Workers Assets, decides which paths the SPA gets. `/healthz` is a liveness-only route on
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
capabilities. Cloudflare hands the provider-owned job to the runner Worker. Zerops runs the
whole deploy in process. Core owns registry/run writes, locking, secret resolution, and generic envelopes.

Runtime surface: `src/env.ts` (ports + vars) · `src/platform-cf.ts` (the raw CF bindings + their
adapters) · `src/services.ts` (how every dependency bag is built). Persistence capabilities live in
`src/db.ts`; the runtime composition root assembles them over D1 or Postgres. Schema:
`migrations/*.sql` (SQLite/D1) and `migrations-postgres/*.sql` (the same schema for Postgres).

Three deploy TRIGGERS, all converging on the same `createRun` + enqueue: (1) the GitHub-App push
webhook (`src/github/triggers/webhook.ts`, private repos, scoped to one connection; after the HMAC check, any
`X-GitHub-Event` other than `push`, a `ping` among them, and a ref deletion are a 204 no-op, and an annotated tag
records `head_commit.id`, the commit it tags, not the tag object in `after`); (2) the manual Deploy button (`triggerDeploy`); (3) the cron
poller (`src/github/triggers/poll.ts`, wired in `scheduled`) for PUBLIC repos with no App install — it conditional-
GETs the repo's commits/tags Atom feed (ETag) and enqueues on a new head sha (`runs.trigger='poll'`).

An env's `trigger_ref` is an exact git ref OR a `*`-GLOB (`src/ref-match.ts` `refMatches`), most usefully
`refs/tags/v*` to deploy on every version tag. It is STORED IN FULL, because a push names its ref in full and the
match is exact: every write path (`put`, `register`, a builder receipt) passes it through `canonicalTriggerRef`, which
keeps a `refs/…` value, turns a bare name into `refs/heads/<name>`, and refuses a value with whitespace or an empty
segment, or one under the workspace branches (`refs/heads/fabrika/`, `WORKSPACE_BRANCH_PREFIX`), with a 400.
`refMatches` matches no workspace branch, so a row stored before that refusal stays readable and is never triggered by
a push, and the poller skips it: a workspace deploys only through `deploy_stage`. Maintenance warns of each such row
every pass (`warnWorkspaceTriggerRefs`). `0009_canonical_trigger_refs.sql`
rewrote older bare rows; one whose full form another env of the app held stays bare, and maintenance warns of it every pass (`warnBareTriggerRefs`). The DEPLOYED ref is always concrete — the pushed ref
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
  `controlServiceContract({ mcp, cli })`, exported as `@fabrika/control/service` with the MCP constants. The proxy
  publishes it through `serviceProxyTable`, and `createControlApp` (`src/app.ts`) serves every row by id with
  `serveService`: a `service` row the proxy did not name in `X-Fabrika-Endpoint` answers 503. Its `*-root` rows
  and the reserved `/webhooks` and `/mcp` keep every path the service answers 404 away from the SPA; with
  `mcp: false`, `/mcp` is a session-only 404 row. The module stays free of the provider and of `src/`, so
  `@fabrika/local-stack` imports it into a strict program.
- **ONE OAuth switch: the digest of the table the proxy publishes.** The composition writes
  `FABRIKA_SERVICE_TABLE_DIGEST` (`installationTableDigest`) beside the Zerops process from the same manifest
  the proxy gets; `createRuntime` reads it through `controlTableSwitch` and refuses to start when it is missing or
  names none of `CONTROL_SERVICE_VARIANTS` (no OAuth; the command-line client's RPC rows; those plus MCP). With MCP
  on, `FABRIKA_CONTROL_DOMAIN` is required too. The Cloudflare Worker reads the same switch (`workerControlApp`) from
  the digest `fabrika.config.ts` writes beside its proxy's table: the command-line client's table on a deployed
  installation, none locally, never MCP's.
- **With `cli` on, `/api/rpc` accepts the command-line client's resource token** for `<FABRIKA_CONTROL_DOMAIN>/api/rpc`
  beside native tokens (`controlAuthenticator` → `createIam(…, { oauthResource })`), so `FABRIKA_CONTROL_DOMAIN` is
  required. Its permissions are the grant's, never more than the person's. **`isPerson` (`src/iam.ts`) is the ONE
  "a person acting directly" predicate**: a user, no `oauth` claims, no delegation link. A manual deploy of a
  protected environment also needs the request to carry no bearer (`isConsolePerson`, `src/approval/human.ts`). Every human-only flow
  (approval and protected-environment changes, source connections, builder pairing and connections, an app's source
  change without a key's approval) and the
  `FABRIKA_CONTROL_BOOTSTRAP_ADMINS` elevation check it; a delegated token is never elevated.
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
  (`readEnvironmentName`, `@fabrika/auth-core`; both roots — `bun/runtime.ts` at boot and
  `controlEnv` on the Worker's first request). Control does not branch on the name today, which is
  exactly why it must not drift: on `fabrika-test` it carried `local` while serving a public
  `.zerops.app` host (backlog 59), so the next `=== 'local'` branch would inherit an installation
  already claiming to be a laptop. The origin is read through `controlPublicOrigin`, so a bare host and
  a full origin mean the same thing; stating no origin is supported and means no claim.
- **Vault (`src/vault.ts`): envelope AES-256-GCM**, KEK from `FABRIKA_CONTROL_VAULT_KEY` (never in D1, never logged).
  Secret VALUES are write-only over the API; D1 stores only ciphertext + wrapped DEK. Losing the KEK is unrecoverable by design.
  `reencryptAll` re-wraps every row in ONE `batch` (a transaction on both dialects) and skips a row the new key already
  opens, so an interrupted rotation changes nothing and a re-run finishes one; never return it to row-by-row writes.
  `src/bun/rotate-vault-key.ts` runs it on Postgres with Control stopped (`docs/reference/key-rotation.md`).
- **GitHub sources are one model on both clouds (`src/github/`, ADR-0029).** `connections/` holds the connection store,
  the management workflow and the vault-held credentials; `source/` the archive, transport and metadata; `triggers/`
  the push webhook and the public-repo poll. Each connection's App id and key
  are a platform vault entry (`platform:github-source:<id>:app-credential`), written in the callback's
  checkpoint transaction and read per operation; nothing caches them, and no App key is a Worker secret or
  env var. Both compositions manage connections from the console (`createSourceConnections`) and mint
  repository tokens with `vaultGitHubCredentials`. A private operation names `(connectionId,
  installationId)` and never falls back to another connection. A read without a binding asks
  `ownerConnectionToken`: the repository owner's connection, when minting a token scoped to the repository succeeds,
  else anonymous (ADR-0029). A registration without a connection is an anonymous
  source: `register` probes it once through `CommitSource.anonymousReadability` (`HEAD`, no token) and refuses a 404
  with 409, so a private repository is not found only at deploy as `ref_not_found`; an inconclusive probe registers. Origins are fixed; seams come only from code
  (the local stack's `control-server.ts`, tests), never from env. `source/archive.ts`, `source/repository.ts`,
  `source/transport.ts` are process-only; the Worker and the shared layer reach `connections/port.ts`,
  `connections/credentials.ts`, and `source/metadata.ts`. **GitHub's anonymous REST limit (60 an hour) is shared by every
  tenant behind a cloud's egress address**, so the Zerops path reads through the tarball endpoint, which that limit does
  not count (ADR-0029): resolve is one archive pass of the requested ref (its pax header names the commit, the pass
  hashes the descriptor), the snapshot is one archive pass of the commit, the upload a third. A ref that is already the
  exact commit resolves once per process, and a platform commit's tree check (two counted reads) runs once per process.
  Never add a per-file `/contents` or `/commits` read to these paths. On Cloudflare `cloudflareGitHubSource` (`src/platform-cf.ts`) resolves the commit and
  builds the runner's clone URL with a repository-scoped token as `x-access-token`. Every gzip stage goes through `pullThrough` (`src/github/source/streams.ts`):
  Bun's compression streams ignore backpressure, and `pipeThrough` would buffer a whole repository.
  A platform archive may carry ONE generated data file (`SourceDataFile`, the Zerops proxy manifest, ADR-0045),
  appended after every entry of the commit; a commit that holds its path is refused, and the upload reports its sha256.
  `createGitHubSource` binds the provider's root descriptor (Zerops' `zerops.yaml`); `createUnboundGitHubSource` binds
  none, for a provider that renders its build from the contract: no digest goes in or comes out, and one handed to it
  is `descriptor_mismatch`. Keep the bound source's types requiring the digest, so Zerops cannot forget it.
- **App secrets are vault-only** (`src/secret-resolver.ts`, D4). `apps.secrets.put` and `vault.set` take the
  plaintext VALUE and seal it (or hand it to a provider that manages secrets itself, `providerKeepsSecrets`, never for
  a `dev` environment, whose sandboxes keep none); no API accepts a ref.
  The resolver knows only `vault:`; any other stored ref — a row from before this rule — THROWS rather than
  deploy with a wrong or empty credential, and is never migrated. It handles ONLY per-app `pipeline.secrets`;
  platform creds are fabrika's own Worker config. `apps.secrets.delete` and `vault.delete` are one use case
  (`deleteAppSecretUseCase`, `src/api/vault.ts`): the value goes first (vault row, or the provider's), the
  registry row last, because the row is the only pointer to the value; an absent value is not an error.
- **A deploy whose declared secrets lack a value is refused before any provider step** (`assertDeclaredSecretsSet`,
  `src/run-lifecycle.ts`). The declared names are the provider's `declaredSecrets` of the registered artifact (Zerops:
  the manifest's `pipeline.secrets`); a name with no `app_secrets` row for the environment (its own or the all-env
  one) fails the run, naming every such name and the environment, never a value. A provider whose artifact does not
  hold the declaration answers `undefined` and checks at deploy itself (Cloudflare: the runner, before any step).
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
- **A domain serves one application environment of the whole installation** (`src/api/registry/domain-ownership.ts`).
  `register` and `apps.environments.put` refuse, with a 409 that names no other environment and before the provider
  prepares anything, a domain another environment holds (compared without case, in any namespace, on every provider),
  and the installation's own hosts (`reservedInstallationHosts`: Control's, which serves the console, IAM's issuer and
  `OPERATIONS_ARTIFACT_ORIGIN`) with every name under them. A `dev` environment's domain is a wildcard base: it holds every name under it against a
  standard environment, and the dev environments of several applications may share one. `idx_app_envs_domain`
  (migration `0044`, every environment but `dev` ones) decides a race; the write maps it to `AppEnvDomainConflictError`.
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
- **Control writes a succeeded run's approved IAM schema and return origins, whichever provider ran it (ADR-0011).**
  `applyApprovedSchema` (`src/run-lifecycle.ts`, over the `IamSchemaPort` of `src/iam-schema.ts`) writes
  `environment.access.schema` under the IAM application id `<app>@<env>` (ADR-0022 rule 6) before the fenced terminal
  write, on all three paths that settle a run `succeeded`: `executeDeploy`, `settleUnfinishedRun` and
  `settleRunCancellation`. A dry run writes nothing and logs what it would. On the awaited deploy any IAM failure fails
  the run; on a reconcile or a cancellation an IAM that does not answer (no response, 5xx, 408, 429) leaves the run
  unsettled for the next pass, and a refusal fails it, with the reason appended to the run log. The port exists only
  when `FABRIKA_IAM_ISSUER` is set (`iamSchemaDeps`, `src/services.ts`); every composition that settles runs spreads it.
  A provider never calls IAM's admin surface for an application, and nothing else here does per deploy, with one
  exception: before the namespace republish and `provider.deploy`, `applyNarrowing` writes what the approved schema
  takes away from the roles and actions of the schema of the environment's last succeeded run, and nothing it adds
  (`narrowingOf`, `src/iam-narrowing.ts`). Any failure there, an unavailable IAM included, fails the run
  with nothing published, so no version serves while IAM still grants what a role lost. Every workload, link mount,
  delegation, member declaration and terminal page of the running schema stays in that write: IAM revokes a dropped
  workload's or mount's keys and deletes the membership transport key with the last of them, which no later write
  restores, so a deploy that fails afterwards would leave the running version without them. A field the new schema
  changes rather than removes keeps the running value. A dry run and a dev bootstrap narrow nothing ahead.
- **The return origin is `app_envs.public_origin` (ADR-0022).** `projectedReturnOrigins` (`src/return-origins.ts`)
  reads it from the DEPLOYING environment only. Never collect another environment's origin: registered under
  `notes@prod`, a `stage` host would be handed production sessions. No origin → the field is ABSENT, not
  empty: fabrika leaves an environment it has no address for unregistered rather than guessing,
  and an empty set would read as "clear the registry".
- **A namespace proxy authenticates itself to each application with a proxy secret (ADR-0022 rule 5).**
  `src/proxy-secret.ts` generates it the first time an environment is handed to a namespace (a republish's
  members, or a deploy's `FABRIKA_PROXY_SECRET`), seals it in the vault under
  `proxySecretPurpose(app, env)`, and records only the ref in `app_env_proxy_secrets`; a lost insert race
  deletes its own vault row and answers the recorded one. Every follow goes through
  `getSecretForPurpose`, like an app secret. Without a vault no secret is handed out, and `executeDeploy` refuses a
  non-dry deploy behind a namespace proxy or on a provider that declares `applicationHopSecret`. There is no rotation
  verb: an operator deletes the record and its vault row and deploys (`docs/reference/key-rotation.md`);
  `FABRIKA_PROXY_SECRET` is a reserved name.
- **A namespace member and a deploy's environment carry `operationsOrigin`, the origin of the active ingest DSN**
  (`ingestOrigin`, `src/operations-catalog.ts`; `namespaceMembers` and `executeDeploy`), so a proxy's header policy
  admits the same Operations origin the framework does. The DSN carries the ingest key; only its origin leaves Control this way.
- **`app_envs.cross_origins_json` is the environment's cross-origin list (ADR-0022 "Cross-origin endpoints")**, set by
  whoever holds `app.manage` (the builder key included) beside `domain`, applied at once without approval (it grants no
  authority: its requests are bearer-only), and read through `appEnvCrossOrigins` / `crossOriginsField` (`src/db/registry-types.ts`).
  `assertCrossOrigins` (`src/api/registry/validation.ts`) judges it with proxy-core's `isCrossOrigin` and
  `MAX_CROSS_ORIGINS`, each once, never the environment's own domain, and names the bad origin in its 400 (by position
  when it carries a userinfo). `apps.environments.put` omission KEEPS the stored list and `[]` clears it, so a put of a
  changed manifest never drops what the operator set; the list a put keeps is judged against the put's domain too. It
  reaches the provider as `ProviderEnvironment.crossOrigins` on every deploy and as `ProviderNamespaceMember.crossOrigins`
  on every republish, absent when empty, and a changed list triggers the same `namespaceProxyChanged` a changed domain does.
- **A job's, a webhook's and a public procedure's key come from the APPROVED contract (`src/workload-credentials.ts`,
  ADR-0022 "Principal kinds", ADR-0063).** `executeDeploy` reconciles one key per workload `contractWorkloads` lists
  (a job, a webhook, a public procedure under its endpoint id) of
  `registration.environment.access.contract` before the provider runs (never on a dry run): a recorded key with more
  than half its 30 days left is read back from the vault, otherwise IAM's `workloads.issueKey` issues a new one with
  the provisioning key (`iamWorkloadKeyIssuer`, at `FABRIKA_IAM_ISSUER`), sealed under
  `workloadKeyPurpose(app, env, kind, name)` and recorded in `app_env_workload_credentials` (vault ref, IAM's
  credential id and expiry). Every issuance names the recorded credential as `keep`, so IAM never revokes the key
  the running version holds; a key issued by a deploy whose record failed is revoked by the next issuance, and its
  vault row is deleted at once. A removed workload's record and vault row are deleted. Each key is handed as
  `FABRIKA_<KIND>_<NAME>_KEY` (a public procedure's as `FABRIKA_PROCEDURE_<ID>_<8 hex>_KEY`) and redacted
  from the run log. Two workloads whose names map to one variable are refused. Without a vault, an issuer or a
  provisioning key a contract with a workload fails the run. What a key may do is IAM's: the schema reconcile
  declares the actions.
- **The maintenance pass renews workload keys without a deploy (`src/workload-key-rotation.ts`), where the provider
  declares `managedCredentials` (Cloudflare).** Under each environment's `<app>:<env>` lease, skipping one a run holds or
  still runs, `renew` re-issues every recorded key of the approved contract with no more than half its 30 days left
  (`keep` = the recorded key, so IAM keeps the one the running version holds valid until its own expiry), records it
  `pending = 1` with `held_expires_at` (the expiry of the key still running), and the provider writes every pending key
  to the running version; only then is the row confirmed. A deploy records each key it issues or reads back while
  pending as `handed_by` its run, and the pass confirms one whose run succeeded without a write and writes one whose run
  failed. A failed write is one `console.error` line (coordinates and the message, never a key) and stays pending for
  the next pass. Before the pass the replaced key is never revoked: a pending key is re-issued only once it is itself
  below the threshold, by which time the key it replaced has expired. The pass checks its lease before each IAM
  issuance and record write, and a record write is a compare-and-set on the key it replaces, so a writer that lost
  the race records nothing. `dev` environments are skipped (their sandboxes
  are bootstrapped before expiry). A provider without the capability (Zerops, AWS) still renews only at a deploy, so an
  environment of it not deployed for 30 days loses its workloads' keys.
- **A held key with a week or less left warns the application's Operations** (`src/workload-key-expiry.ts`): at most one
  `WorkloadKeyExpiring` warning per key and day, the keys of one environment in one event (`expiry_warned_at`, cleared
  by every new key) to the ingest of its
  active DSN, through the Worker's Operations binding or the global `fetch`, `redirect: 'manual'`; an `error` once the key
  has expired. The held key is the recorded one, or while it is pending and no succeeded run handed it, the one it
  replaced (`held_expires_at`). Without an active ingest the warning is the log line alone. Every pass first confirms,
  on any provider, each pending key a succeeded run handed (`confirmHanded`), and a later run never takes over a
  `handed_by` a succeeded run holds: otherwise a provider without `managedCredentials` would keep every key pending,
  and a failed redeploy would hide the expiry of the key still running.
- **The maintenance pass reads exposure back between deploys (`src/exposure-watch.ts`), where the provider declares
  `exposure` (Zerops).** Under each environment's `<app>:<env>` lease, skipping one a run holds or still runs and every
  `dev` environment, it calls `exposure.check`, bounded at `EXPOSURE_CHECK_TIMEOUT_MS`; a set of findings other than the
  one recorded in `app_env_exposure_alerts` raises one `FabrikaExposureDetected` error event in the application's own
  Operations, its fingerprint carrying the raise time so each raise is a new issue that `new_issue` rules notify
  (`sendControlEvent`, `src/operations-event.ts`, the transport the workload-key warning uses) and is recorded once
  Operations took it, refused it for good, or there is no ingest; a failed delivery is sent again by the next pass. The
  same exposure is not raised again while it lasts; a check that finds none deletes the row. It only reports: the next
  deploy's `verify-exposure` refuses the exposure.
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
  the break. `assertMountCompatibility` refuses, the same way, a candidate that breaks a procedure of a mount the
  approved contract promises `compatibility: 'backward'` (`incompatibleMountChanges`), including the generated challenge
  URLs its clients fetch. `connectors.describe` answers the approved export to its consumer for `fabrika connect`, behind
  `deploy.read` on the consumer, and the same 404 for anything else.
- **Signed-token keys and the application origin are Control's (migration `0012_token_keys`).** Each environment's
  token keys live in the vault (`app_env_token_keys`) and are handed as `FABRIKA_TOKEN_KEYS`, the signing key first,
  only when the approved contract declares a token purpose; `apps.environments.rotateTokenKey` asks the next deploy to
  rotate, and a retired key verifies until its retirement plus the largest `maxDays` the contract had while it signed.
  Every deploy writes `FABRIKA_APP_ORIGIN` (the environment's public origin, or `null`, which removes it).
- **The installation's hosts go to a job with public egress (`src/egress-hosts.ts`, ADR-0075).** A deploy whose approved
  contract has a cron job with `egress: 'public'` hands `FABRIKA_EGRESS_REFUSED_HOSTS`: the hosts of Control's origin,
  IAM's issuer, the environment's Operations ingest and every environment of the provider (domain and public origin),
  normalized, sorted, joined by `,`; a public variable. Every other deploy hands `null`, which removes a stale list. A
  host added later reaches an environment at its next deploy.
- **The ops key is Control's, and the object holds only its digests (`src/ops-key.ts`, ADR-0069).** A non-dry deploy
  of an environment with a domain hands `FABRIKA_OPS_KEY_DIGESTS` only when the provider's `opsChannel(access)` says the
  approved release serves the channel (the release gate is the provider's), and `null` otherwise, which removes it after
  a downgrade. The digests are a public variable: a SHA-256 of a 256-bit random key forges nothing. Each key is sealed
  under `opsKeyPurpose(app, env, keyId)` and recorded in `app_env_ops_keys` with its digest and `handed_by`, the newest
  run that handed it while no running version accepted it; that run's success is the acceptance, so a dry run's never
  counts. Every record write is fenced on the run's lease in the same batch. A key at least 15 days old rotates: the
  deploy hands the old digest and the new. The old key goes only at a deploy after one carrying the new key succeeded,
  its record first, under the lease, and then its vault row; a ref not sealed under the key's own purpose is never
  deleted and its record stays. `opsKeysFor` answers the keys Control may present, the newest first and at most two (a
  pending key, then the accepted one), because a version can run although its run failed later; a caller tries each in
  turn. Each key is bound to a domain (`app_env_ops_keys.domain`): a new key has none, and the provider's acceptance of
  the deploy that handed it (`events.externalId`) binds it to that deploy's domain, never changed afterwards. `opsKeysFor`
  answers only bound keys, so a domain the registry names but no provider deployed to receives no key; a deploy to
  another domain than the accepted key's issues a new key, and replaces a pending key bound elsewhere. Without a vault a
  gated deploy fails.
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
  A run whose holder died before a provider accepted it (a Control restart) is failed by the next owner
  (`settleUnfinishedRun`: startup reconcile, cron, or the environment's next deploy), which first appends
  `RUN_INTERRUPTED_REASON` through `runLogs`; the stale-run sweep appends its own reason. Neither requeues the run
  (ADR-0044): every composition hands `runLogs`, or the reason reaches the console only.
  A pending run older than a run of the same environment and lane that already `succeeded` never starts (`runs.lane`
  is null except on a dev bootstrap, whose lane is its workspace): `markRunStarted`
  refuses it, also after `startRun` settled a newer run to succeeded, and then `markRunSuperseded` fails it, records
  that run in `runs.superseded_by` (the approval page's `ApprovalDto.supersededBy`), and its log says
  `superseded by run <id>` (ADR-0044). Queue order is not run order (a deferred run is enqueued again), and
  an approved parked run is covered the same way. Cloudflare's `resolveSource` resolves a webhook or poll run's BRANCH
  and refuses it (`commit_mismatch`) when the branch moved past the recorded commit (ADR-0048).
- **A deploy run is the one writer of an environment's artifact besides the registry API (ADR-0043).** On a
  `descriptor_mismatch` at resolve it asks the provider's `withSourceDescriptor` for the artifact with the commit's
  descriptor, deploys with it, and stores it with `replaceAppEnvArtifactForRun` once its publication passed: under the
  run lease, only over the artifact the run read. Never from a dev bootstrap or a workspace branch's run, which fail as
  before.
- **Control is the only writer of a run's row (ADR-0044).** A Cloudflare run settles in exactly two ways,
  both under the run's lease: the awaited `startRun` result (`executeDeploy`), or — after a Control
  restart such as a self-deploy — `reconcileProviderRuns`, where the provider's `reconcile` reads the
  status the runner Worker persisted in R2 (`recoverRun`, parsed in `platform-cf.ts`). Either way Control
  writes the IAM schema BEFORE it marks the run terminal, so a terminal row is never re-opened. An invalid
  runner report fails the run. IAM replaces the app's whole vocabulary, so a re-application after a lost
  lease is harmless. A redelivery or a second reconcile finds the row terminal and applies nothing. A dry
  status is projected dry and applies nothing.
- **The Cloudflare provider owns the runner boundary.** `CloudflareRunnerJob` and its validator live in
  `@fabrika/provider-cloudflare`; its oblaka-free `./runner` entry also carries the transport schemas, types and
  endpoint constants, `@fabrika/runner-container` owns the Bun process and image, and
  `@fabrika/runner-cloudflare` owns the executor Worker.
  The control plane has NO `Container` binding. The split exists because a deploy's final
  step runs `wrangler deploy` INSIDE the container, and when the target is fabrika that resets fabrika's DOs —
  so a container hosted in fabrika would reset ITSELF mid-deploy. Hosting it in the runner Worker means a fabrika
  deploy never touches it. As a consequence fabrika has no `Container` → no docker → it's deployable THROUGH
  the runner. The runner Worker writes only R2 (logs and the terminal `status.json`), never the database.
  The runner Worker is deployed out-of-band (its own bootstrap).
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
- **A data operation drives an environment's object under its `<app>:<env>` deploy lease (`src/data-operations.ts`,
  ADR-0069).** Control allocates every generation, records each step fenced on the lease, and calls the object only
  through the injected `OpsTransport` (`httpOpsTransport`: each ops key the running version accepts as a bearer, at the
  domain that key is bound to, never the registry's, newest first, the next one only after the uniform refusal; no key
  bound to a domain is `no_channel`; no redirect followed). A lost answer
  repeats the same generation and mode. A successor (`advanceDataOperation`, or a recovery's resumed operation) first
  publishes a generation above every reserved one in the recorded mode. `advanceDataOperation` drives only the
  environment's newest running operation, and a succeeding recovery retires every operation still running in the chain
  it recovers, so the newest record is the object's mode. A 409 naming a higher generation is adopted once, behind a
  fenced write; any other 409 fails the operation `stale_generation`. A lost lease stops it with no further write or
  request. `executeDeploy` refuses an environment whose recorded mode (`recordedMaintenance`) is not `open`; the only
  deploy of such an environment is `executeDeployUnderLease`, which runs under the operation's live lease and never
  releases it. `data.read` and `data.manage` are checked at the coordinates, `data.content.read` as a global grant only,
  and every denial is the 404 of an absent environment; `data.view` refuses an answer that carries content.
  An object whose release does not serve `state` or `migrate` answers 501 `{refused:'not_implemented'}`; the operation
  fails `not_served` at once instead of staying running, `recordedMaintenance` skips it, and deploys stay open.
- **A daily backup is a `backup` data operation the maintenance pass starts (`src/backups.ts`, ADR-0070 §7–§8).** Its
  steps are `restrict` (`read-only`), `backup` (the export's steps), `open` at a new generation, then `verify`, the
  rehearsal into the object `rehearsal`. Every step and part is recorded fenced on the lease (`app_env_backups`,
  `app_env_backup_parts`), so a successor resumes where the record stops; a pass is bounded and leaves the rest to the
  next. Only an environment whose approved release the provider's `dataOperations` serves gets one, and a provider
  without it (Zerops) drives no data operation. A resumed dump sends `begin` again with its recorded `dump_id`, which the exporter replays while the dump's
  stretch of modes that write nothing holds (ADR-0070 §2), then continues from the recorded parts. Only that `begin`'s
  `ledger_mismatch` starts the dump again under a new `dump_id`, its recorded parts dropped and its old upload
  abandoned. A backup's terminal outcome is written in one lease-fenced batch with its operation's next step or
  end (`BackupCheckpoint`), and a step that finds the outcome already written sends nothing. A failed export reopens the
  object; a failed rehearsal fails the backup with the object already open, and `recordedMaintenance` reads both as
  `open`. A pass starts at most four backups, counting only the ones it created, and an environment waits an hour after
  its last failed backup ended. An environment opts out in `app_env_backup_schedules` under
  `data.manage`; `data.read` lists its backups, one older than 30 days as expired. `data.start` with kind `backup` still
  answers 501.
- **A deploy that brings a pending application migration is a `migrate` data operation (`startMigration`, driven from
  `deployUnder`; ADR-0069 §3, ADR-0070 §8).** Every non-dry run records `runs.migration_barrier`: whether the version it
  deploys installs the maintenance barrier (a domain, at a release the provider's `opsChannel` and `dataOperations` both
  serve; a release can serve the channel's `inspect` without the barrier's `state` and `migrate`). Once the run published
  its snapshot, a deploy that installs the barrier, where the environment's last succeeded run recorded it installed too
  (`deployedMigrationBarrier`; never the published snapshot, which precedes the provider and survives a failed run),
  compares the candidate's bundled migration files (`.sql` directly in `db/migrations`) with the object's ledger from
  `inspect` (`pendingMigrations`). Without an installed barrier the deploy is plain and the object migrates on its cold
  start, as on the first upgrade onto a gated release and on every deploy of a release without the barrier. An
  installed barrier whose channel does not answer, or an installation without
  `RunDeps.ops`, fails the run before any provider effect. A pending file makes the run's own invocation drive the
  operation under the run's lease: `restrict` (`read-only`), `backup` and `verify` at that generation (a backup record
  with `pre_migration = 1`, rehearsed while the object stays restricted), `deploy` (the run's own deploy; a provider that
  answers `running` is settled under the same lease with `settleUnfinishedRun`, bounded), `migrate` at the published
  generation, `open` at a new one. The record keeps `run_id`, and a successor at `deploy` only reads that run's row. A
  failed dump or rehearsal, a run no provider accepted, or a failed run its provider reports `untouched` (it stopped
  before its first migration or deploy, recorded as `runs.failure_cause = 'untouched'`), reopens the object
  (`backup_failed`, `rehearsal_failed`, `deploy_not_started`, read as `open`) and fails the run without a deploy. Any
  other run that failed after a provider accepted it (`deploy_failed`) and a refused migration or failed boot
  (`migration_failed`) fail the operation with the object
  restricted, for an operator's recovery; no answer leaves it running (interrupted). The run's status is its deploy's
  (ADR-0044); the operation's outcome is the last line of the run's log. A running migration whose lease is free has
  lost its driver (the run's invocation holds the lease from its start to its settlement): the maintenance pass resumes
  it as a successor, and a held lease makes `advanceDataOperation` answer busy, so a live driver is never overtaken.
- **A candidate that records the migration bookmark migrates without a read-only window** (`migrationBookmark` on the
  provider, from the candidate's pin; `records_bookmark = 1`, `bookmarkMigrateStep`; ADR-0069 §3). No backup and no
  restricted mode, `dataLoss` included: `deploy` (as above; a run no provider accepted, or `untouched`, fails
  `deploy_not_started` and asks nothing), then `migrate`, which publishes `open` at the operation's generation and asks
  `migrate` every 10 s until a 200 holds every candidate file with its snapshot checksum, or the record's `deadline_at`
  (`max_delay` 300 s plus 60 s) passes. Any other 200, a 500 and no answer are the old version still running; past the
  deadline the operation fails `migration_unconfirmed` (`deploy_failed` when the provider failed the run after it
  uploaded; such a run is still asked, and its 422 enters the recovery below). Only the 422 `migration_failed`
  (`parseOpsMigrationFailure`) is a failure, recorded as `migration_failure` with the answering Worker version
  (`candidate_version`, the answer's `version`, else the record's): `rolled_back`, `record_unwritable`, and `committed`
  without `data_loss`, go to `revert`, the rollback deploy of `getLatestDeployedRun` (a succeeded run that recorded its
  migration barrier, so never a dry run, and not the operation's own), through `OperationDeploys.run` under the same
  lease. `revert_run_id` is named before the run is created, and `deployUnder` exempts that run from the `deploy-request`
  decision as it does a restore's deploys; its publication returns to the snapshot the redeployed run published
  (`rollbackReturn`, `PublicationInput.returnTo`), which needs no new approval even where it widens. `check` then waits to a new deadline for a 200 of another version than
  `candidate_version` and fails `migration_reverted`; without a known version it waits to the deadline. A 200 of the
  failed version itself (its boot retried and succeeded) records `candidate_recovered` and goes to `restrict`. So do a
  committed `dataLoss` migration (the in-place rewind is not built), a rollback that fails or is not accepted, and one
  that does not answer by the deadline: `restrict` publishes `closed` at a new generation and fails `migration_failed`.
  `recordedMaintenance` reads a failed bookmark migration whose target is still `open` as `open`. The maintenance pass
  resumes each step; its time bound pauses a wait, which the next pass continues to the recorded deadline.
  `RunDeps.opsClock` and `DataOperationDeps.clock`/`wait` let tests move that clock.
- **A bookmark migration's run ends with the migration.** The provider's success records `deployed` on the operation and
  leaves the run `running` (`holdForMigration`, in `deployUnder` and `settleUnfinishedRun`, which answers `held`), so it
  is no baseline. The operation ends it through `OperationDeploys.finishRun`: `succeeded` only when the new version
  answered, `failed` at `revert` (first, since an environment runs one run at a time) and at every failure. The
  reconciler ends a `deployed` run whose operation ended without it (a recovery's `open`) as the operation did; a run
  not known deployed first settles its provider's work, which may still activate, and then fails.
- **A migration that may change stored data runs only behind a backup (ADR-0050, `deployUnder`).** The files are the candidate's
  `dataLoss` of any kind that the environment's last succeeded run did not deploy as they are now (`unheldDataChanges`,
  never the publication). A stored snapshot without `dataLoss` is classified again at its commit (`rereadDataLoss`), and
  when that fails every unheld file counts: absent never means "changes nothing". A provider with `dataOperations` deploys
  them only through the migration phase: without an installed barrier the run is refused before any provider effect,
  naming the cause. Any other provider is handed `backupBeforeMigrations` and backs up itself. A restore's deploy that
  would bring one is refused; which run is a restore's comes from its record (`RestoreRepository.namesRun`). A dry run and a dev bootstrap are handed nothing.
- **A side restore is a `restore` data operation (`startRestore`, `data.start` kind `restore` with a past `at`;
  ADR-0070 §9).** `data.start` only records it, the operation and its `app_env_restores` row in one lease-fenced batch,
  and returns it at `list`; the maintenance pass (`runBackupSchedule`, both hosts) owns it and drives it under the lease
  as a successor, bounded per pass. Control records the pointer per environment (`app_env_application_objects`: the
  serving object and the listed ones, at most 16), and every deploy (`deployUnder` →
  `ProviderDeployInput.applicationObjects`) writes it; without a row it is `application` / `application,rehearsal`, and
  `inspect`, `migrate` and the backups follow the recorded serving object. Only a restore's own deploys
  (`operationDeploys`, redeploying the newest succeeded run under the operation's lease) move it, recorded in the batch
  that advances the step. A resumed restore first publishes each object's mode at its step (`restoreModes`). Steps:
  `list` (the listing deploy, then `inspect` of the clone: the channel reaches only a listed object, so a refusal is a
  runner that did not forward the pointer, `objects_not_deployed`, before anything is frozen), `restrict`/`backup`/
  `verify` as a backup, `import` into the clone (`inspect`), `promote` (clone `open`, original `inspect`), `point` (the
  pointer deploy; one no provider accepted reopens the original), `serve` (positive confirmation: `prepare` on the
  original is refused as `serving_object` while traffic still reaches it, and its bookmarks are recorded before any
  `arm`; then `migrate` on the clone answers only once it booted while not `inspect`), `rewind` (each `arm` counted
  before it is sent and sent once, then `verify`; at most three arms), `check` (the original's ledger within the
  clone's). Only a pointer that did not move goes through `revert` (a deploy pointing back) to `open`, which fences the
  clone `inspect` and opens the original; every such code reads as `open`. A clone that gives no boot answer leaves
  `serve` interrupted, never reverted: a boot failure lives in one instance's memory, so nothing proves the clone never
  served. `bookmark_unavailable`, `rewind_failed` and `unexpected_schema` leave the clone serving and the original
  `inspect`. A recovery with resolution `open`, also of an interrupted recovery (the chain resolves to the restore),
  keeps the object that may hold writes, where traffic goes: the clone once a provider accepted the pointer deploy,
  nothing showed the clone served no request, and `prepare` proves the pointer moved (or `serve` recorded that it did);
  else the original, pointed back first. It settles with the clone `open` and the original `inspect` without the
  clone's boot, so a clone that never boots is a broken deploy an ordinary deploy repairs; only the rewind needs
  `serve`'s boot answer. A restore deploy without an outcome or an unclear answer leaves the recovery interrupted.
- **Namespace provisioning is a JOB, not a request** (`src/api/namespaces.ts`, backlog 74). `create` /
  `adopt` / `reconcile` persist the row `pending`, enqueue, audit and return; the worker claims
  `pending`→`provisioning`, runs the provider mutation with its OWN signal, and records `ready`/`failed`.
  The job holds a `namespace:<id>` lease in the same `deploy_locks` table, on the same TTL — a namespace
  left `provisioning` is deliberately RESUMABLE, so unlike a run
  nothing else refuses a redelivery and the renewed lease is the only guard against one.
  `reconcile` on a namespace that is still settling moves its STATE back to `pending` and enqueues; it
  must never rewrite `provider_target_json`, or a checkpoint the running job just wrote is rolled back
  under it. Only a job's claim moves a `pending` row, so the running job leaves it `pending` and the
  queued job runs after it. Every write that records a provider target (a job's or a republish's checkpoint
  and result, the update's stored write) acquires that target's `namespaceResourceClaims` in the same fenced
  batch, because a member deploy refuses a namespace with a missing claim; a key an app environment holds
  fails it as `resourceClaimConflict`. A write that re-records the stored target acquires nothing.
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
  before `provider.deploy`; `deleteApp`, `deleteAppEnv`, a changed `domain` or cross-origin list and a changed namespace
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
- **Every namespace mutation hands the provider the installation's client logo** (ADR-0066,
  `src/installation-brand.ts`). IAM keeps it; Control reads it with the provisioning key (`iamBrandSource`, wired by
  `installationBrandDeps` when `FABRIKA_IAM_ISSUER` and `FABRIKA_IAM_PROVISIONING_KEY` are set) inside each provider
  mutation and republish. The logo is presentation, so a read that fails, or that IAM leaves unanswered for
  `BRAND_READ_TIMEOUT_MS`, publishes fabrika's mark and logs a warning:
  an IAM that does not answer holds up no namespace and no deploy, and the next publish draws the logo again.
  `namespaces.republishAll` (`namespace.manage`) is the one exception: it reads the logo once, refuses with a 502 when
  IAM does not answer (the change it was asked to publish would reach no proxy), republishes every ready namespace at
  once with it (one a deploy holds is no failure: `NamespaceProxyBusyError`, the republish queued its reconcile), moves
  one still `provisioning` back to `pending` and queues its reconcile, as `namespaces.reconcile` does, and audits each
  before it reports a failure; the
  console calls it after a logo change. Control keeps no copy, though it costs each mutation one more IAM call: a copy
  that only `republishAll` refreshes would leave every later deploy publishing an old logo (ADR-0066, alternatives). Control's calls to IAM as itself (the brand, membership
  keys, workload keys) share one client, `iamProvisioningClient` (`src/iam-provisioning.ts`).
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
- **MCP authoring is a Bun-only protocol adapter (ADR-0049).** `src/bun/server.ts` routes
  `POST|GET|DELETE /mcp` to `src/mcp/handler.ts`; everything else reaches `controlApp`. The Worker graph
  never imports the MCP SDK (`entrypoint-isolation.test.ts`). `/mcp` verifies the injected token for the
  resource profile `controlMcpResource(controlPublicOrigin)` only, requires `AuthContext.oauth` and a
  user, and never applies the bootstrap-admin hatch. The tools call `src/api/workspaces.ts`, which reaches
  the repository through the `WorkspaceSourcePort` — `src/github/workspace.ts`, the binding's own GitHub
  App with its key read from the vault per operation. A workspace is the branch `fabrika/<id>` owned by one
  principal; every use case re-checks `app_envs.authoring`, the action at the coordinates and ownership, and
  answers 404 otherwise. Paths are repository-relative (`isRepositoryPath`, at the MCP boundary), and
  protected paths (the provider's `authoring.protectedFiles`, every `fabrika.*` but the exact `fabrika.contract.ts`, everything under
  `.github/`) are refused before GitHub is called. `get_deployment` reaches only runs of the caller's own
  workspace branches, and reports a parked run with its approval link and every run's `deviations` (its lines that
  need closer review). `get_app_rules`
  answers the body of `@fabrika/app`'s `skill/SKILL.md`; the server `instructions` stay under 2,000
  characters (some clients cut them at 2 KB) and point to it. Never restate the rules beyond those three lines.
  One authoring environment per app, on a provider that declares `authoring`: `apps.environments.put` answers 409 while another env holds the flag.
  An authoring environment is never protected (ADR-0049 rule 7): `put` refuses `authoring: true` on a protected one (a
  new `prod` included), and `apps.environments.protect` refuses an authoring one, in the use case and in the
  conditional write of `setAppEnvProtected`.
- **A `dev` environment gives each MCP workspace its own sandbox, which follows the workspace without a run
  (ADR-0049 rule 10).** `app_envs.kind = 'dev'` is set at creation and never changes; one per app, never `prod`, never
  protected, never authoring, no trigger ref, with a `domain` (the wildcard base), and only on a provider with
  `devSandboxes` (Zerops); it claims no provider resource, and deleting it or its app, or the environment its workspaces
  belong to, is refused while one of those has a sandbox row (`assertNoDevSandboxes`, `src/api/registry/apps.ts`). `dev_sandboxes` holds one row per workspace with a
  sandbox (the one-service `dev_environments` was dropped by `0027_drop_dev_environments`), metadata only: the sandbox id,
  state (`creating`/`ready`/`removing`), its proxy secret ref, its bootstrap and published runs, the target head, what
  the launcher last reported (head, status, message, trimmed log), a refused head, the reset and check generations, and
  `parked_at`/`woke_at`. `src/api/dev-environments.ts` holds `bind_dev` (`ensureDevSandbox` on every bind: the
  provider's `admit` before the row exists, since every republish hands a recorded sandbox on and a pin that cannot parse
  it would stop the namespace's publication, and only its non-retryable `ProviderNamespaceError` is the author's 409; it
  creates the sandbox again when Box lost it, removes the row a failed create started (only the bind that inserted it,
  `create_attempt`, and never while the sandbox host is pending or the namespace busy: the row makes the queued
  reconcile create the host), and removes a sandbox Box finished after a removal took its row; then a wake, then a bootstrap run when the sandbox was replaced or
  `needsBootstrap`: none succeeded, a head was refused, the launcher is gone or unreadable (`launcherProblem`), IAM
  holds another workspace's contract (`app_envs.iam_digest`), or `syncRefusal` of the paths from the held head),
  `get_dev_status`, `run_checks`, `reset_dev` and `followDevCommit`, which `apply_changes` calls; `src/dev/service.ts`
  holds the sandbox lifecycle. Every sandbox call composes the namespace's sandbox host key from the vault
  (`deployment_namespaces.sandbox_key_ref`, `src/dev/sandbox-keys.ts`), generated on first need and never logged.
- **A dev bootstrap is an ordinary run in its workspace's lane.** `createManualRun` sets `runs.lane` to the workspace;
  supersede (`src/db/runs.ts`) and publication are scoped to the lane: a bootstrap classifies against its workspace's
  own published run, publishes through the environment's compare-and-swap (so IAM follows the newest bootstrap), and
  records itself in `dev_sandboxes.published_run_id`, from which the namespace job compiles that sandbox's entry. A
  dev run without a workspace is refused. The `<app>:<env>` lease still serializes the environment's bootstraps.
- **Per workspace: the proxy secret, the `source` key and the return origin.** The namespace job hands one
  `devSandboxes` entry per sandbox row `creating` or `ready`, with its own sealed proxy secret. `platformTransport.issue(…, { workspaceId })`
  issues the `source` key bound to the workspace (`platform_transport_keys.workspace_id`), only while the workspace's
  sandbox row exists and is not `removing`, and the receiver
  (`src/dev/receiver.ts`, the `dev-source` protocol row, ADR-0064) authenticates it to `{ app, env, workspace }`; a key
  without a workspace is refused. A held wait answers the files between the head the launcher holds and the target,
  never stored: the files `apply_changes` just wrote when this process holds them (`DevSignals.offer/take`, only from
  the exact parent to the target), else a GitHub compare (`src/dev/sync.ts`) in one `WorkspaceSourcePort.session`.
  Both requests carry the bootstrap commit; one that is not the workspace's current bootstrap run's gets 409. The IAM
  return origins of a dev environment are the origins of its ready sandboxes (`src/return-origins.ts`). `run_checks`
  is refused while the served head is not the target. `DevSignals` wakes a wait in this process; every wait also
  re-reads the row each second, for another Control container. A deploy of a `dev` environment refuses a framework
  release before `DEV_LAUNCHER_SINCE` (`src/dev/deploy.ts`) before anything publishes.
- **Maintenance parks and removes sandboxes; abandoning a workspace removes its sandbox.** `maintainDevSandboxes`
  (`src/dev/service.ts`, the `devIdle` slot of `runMaintenance`) parks a sandbox idle for 30 minutes and removes one
  left `removing`, of an abandoned workspace, idle for 14 days, or `creating` for an hour (a bind that died); a commit,
  bind, reset or check request wakes a parked one. `removeDevSandbox` marks the row `removing` first (the proxy stops
  routing it), then deletes the Box sandbox (the recorded one and any other under the workspace's name) and
  the workspace's `source` keys, and only when both succeeded its proxy secret and the row; it republishes the
  namespace either way, and a row left `removing` is retried by the next pass. Maintenance marks a row only while it is
  still removable (`markRemovingIfRemovable`), so a bind or commit meanwhile keeps the sandbox. `delete_workspace`
  calls it through `WorkspaceUseCaseContext.devSandboxRemoval` (refused up front without a vault when a sandbox
  exists), and marks the workspace abandoned even when the Box call failed; maintenance then finishes the removal.
- **Published access comes ONLY from `approvedSnapshot(app, env)` (ADR-0050, `src/approval/`).** Right after the
  commit is pinned, `executeDeploy` reads the run's snapshot (`readAccessSnapshot` over `env.COMMITS`;
  `contractReaderInputs` names the files: on Zerops one archive pass keeps the files `snapshotReads(root)` wants,
  `archiveCommitSource`; on Cloudflare the commit's tree and files through the GitHub metadata client), stores it
  on the run, classifies it against the active snapshot (`classifyAccess`, pure, conservative) and either parks
  the run in `awaiting_approval` (a line in one of the environment's chosen approval categories, `waitsForApproval`,
  on a `protected` environment without a matching approval; ADR-0083) or
  publishes it with `publishRunSnapshot`, a compare-and-swap on `app_envs.generation` and `protection_revision`
  fenced on the run lease and taken under the namespace lease; a lost swap classifies again. Before each attempt,
  the provider's optional, mutation-free `validateAccess` checks the candidate against the current placement, so an
  incompatible proxy never receives a published snapshot. The snapshot is read
  at `provider.applicationRoot(source)`, the provider's own normalization of `workerDir`. `providerEnvironment` and
  `namespaceMembers` attach `approvedProviderAccess`, so every deploy, cancel, reconcile, registry hook and
  namespace job hands the provider the approved access and nothing else: `access`, the approved contract. A commit
  without `fabrika.contract.ts` fails its run with `ContractMissing` before the provider is called, and publishes
  nothing. A fresh snapshot read also hands the commit's `bun.lock` to the provider's optional, pure `lockfileRefusal`
  (Zerops: can the build base install from it); an answer fails the run with it, before anything publishes. A stored snapshot's legacy `artifact` field is dropped when it parses, and a publication without a contract
  reads as the empty baseline (`approvedSnapshot`). `runs.pending_access_json` is no longer read or written. The
  published snapshot lives in `app_envs.published_snapshot_json`. A snapshot whose plain JSON exceeds
  `STORED_SNAPSHOT_BYTES` (a D1 row holds 2,000,000 bytes) stores its contract in the shared encoding (`encodeArtifact`),
  which `parseStoredArtifact` decodes to the same artifact and digests; one that fits stays plain, so a Control rolled
  back below the encoding still reads it. The encoding still costs each distinct field its name: `readAccessSnapshot`
  refuses a snapshot whose stored form still exceeds the ceiling as `contract-too-large` (`storedSnapshotFits`). On the Worker
  a run's snapshot and classification are objects in `RUN_LOGS` under `access/<sha256>.json` and the row holds
  `sha256:<hex>` (`RunRepository` with `runDocuments`); on Postgres the row holds the text. Read a run's
  `snapshot_json` or `classification_json` only through `runs.document`, never parse the column. Every deploy reads
  the last succeeded run's object, and a missing one fails it: never expire or delete `access/` in `RUN_LOGS`. Snapshot log lines are codes and counts only. A new write path must take it the same way; reading access
  from the provider artifact is a bug. An approval names both digests and holds only for them.
- **An application is read by the reader of the framework release it pins (ADR-0062, `readers.ts`, `formats.ts`).**
  `readAccessSnapshot` reads the `@fabrika/app` release from `<root>/bun.lock` and picks this release's reader for its
  own minor, or the bundled npm alias of an older one (`@fabrika/check-0.4`, `@fabrika/check-0.5`,
  `@fabrika/check-0.6`, `@fabrika/check-0.7`, `@fabrika/check-0.8`). A release outside the window, newer than the platform, or a root without a registry `bun.lock`
  entry fails the run with `FrameworkReleaseRefused`, one line of versions and fixed names. The snapshot keeps an older
  release's artifact in `older` and stores and digests that one; `contract` is it upcast to this release's model, which
  the diff, the proxy table and the IAM schema read. `approvedAccess` hands the provider the digest the application's
  release computes (`applicationContractDigest`) and the reader's release (`checker`), which the build checks with;
  never recompute a digest from the upcast contract. A 0.4 or 0.6 artifact is a 0.5 one (`from04`, `from06`); a 0.7 one is
  this release's format, kept and read as it is (`from07`), and so is a 0.8 one (`from08`). A 0.5
  artifact keeps its forms, collection rows, `then` and inbox policies, which the proxy table, the IAM schema and the
  diff still serve; the upcast gives a job's `timeout` as `timeoutMs` (15 min without one) and a webhook the 10 s it ran
  with. A model change adds its upcast rule in `formats.ts`, and `framework-compat.test.ts` keeps every older minor of
  the window reading as its own platform read it.
- **Relation fields publish only to a framework that enforces them** (ADR-0073 §5, `src/approval/enforcement.ts`, the
  floors in `src/approval/floors.ts`).
  `relationGrantsRefusal` refuses a snapshot that declares a relation, a role's `via`, a table's `confers` or `when`
  for an application pinned before `RELATION_GRANTS_SINCE`, and a table's `relationWhen` before `RELATION_WHEN_SINCE`
  (`relationFloors`, one list of floors; the refusal names the highest one missed), compared by prerelease precedence
  (`comparePrecedence`), before anything publishes: a reader that ignores a narrowing field widens access. A floor is
  the first release whose source enforces its fields, so a field that lands between releases takes the next prerelease
  after the source version; `enforcement-floors.test.ts` holds every floor at or below the source version or at that
  next prerelease. `release:validate` refuses a tag below a floor of its source, and `release:hotfix` a tag that reaches
  a floor its base is below (`PUBLISH_FLOORS`, which `scripts/release.ts` imports, so `floors.ts` takes type imports only). The approval diff classifies each relation field (`table.confers`, `table.when`,
  `table.relation-when`, `table.reveals`, `table.read-through`, `table.write-through`, `table.member-reveals`,
  `table.access`, a role's `via`): a new `via` action, source table, reveal, read-through or write-through action
  widens, a longer or self delegation widens, an added `when` or `relationWhen` narrows, a removed or changed one
  widens. An added or changed access view widens with closer review, and a removed one narrows (ADR-0076); the
  database-code line of a view that some table names under `access` says which relations its SQL decides, and an entry
  that newly names an already-deployed view shows its SQL again. `access` counts at `RELATION_WHEN_SINCE`: an older
  release refuses the field at build and boot rather than ignoring it, and the floor turns that failure into a refusal
  before anything publishes. A member
  reveal keyed by a read-through dimension names its path and shows its `assign` as a reveal's. `writeThrough` and such
  a member reveal reach less when ignored, so `relationFields` does not count them. A membership role's `via` needs no
  floor of its own: a framework before `0.9.0-dev.14` refuses to build one, and reads no `~relin` entry, which IAM
  signs for a scoped grant of a role with `via`; `relation-token-compat.test.ts` holds every auth-core release of the
  window to reading neither `~rel` nor `~relin` as a value or a global grant.
- **`apps.environments.suspend` takes an environment offline; `resume` restores exactly what it had**
  (`src/api/registry/suspension.ts`, `app.manage`, audited `app.env.suspend` / `app.env.resume`). A provider with a
  namespace republish records `app_envs.suspended_at` and republishes, so the member reaches the provider `suspended`
  and its entry answers 503; it asks `namespaces.assertSuspendable` first, and a refusal (a pin whose parser does not
  read the flag) is a 409 before anything is written. Any other provider goes through the environment's object: the
  row records the maintenance mode it was in (`suspended_from_mode`, `open` or `read-only`) BEFORE the `closed`
  operation starts, so a `resume` after an interrupted close still restores it; a refused start clears the record. Every
  record write is a compare-and-set on `suspended_at` (`setAppEnvSuspension`), so only the call that wrote a record
  clears it. The suspension changes no `generation`. Both verbs are retries: a repeated suspend republishes (or closes)
  again. A suspended environment cannot change namespace (`apps.environments.put`), whose pin may not read the flag.
- **A Zerops namespace pinned to an older proxy source is judged by that release's own manifest parser
  (`src/zerops/older-proxies.ts`).** It holds the parsers of `@fabrika/proxy-core` 0.4.8, 0.5.5 and 0.6.0, and the
  Zerops provider refuses a deploy of a row none of them parses, or of a CSP none of them parses (the CSP field of each
  release's entry parser) (`older-proxies.test.ts`). Only the Zerops composition imports it, so the Worker bundle carries
  none of them. Never add a parser of a minor newer than 0.6 while a pin's release is not recorded: the provider deploys
  what any parser reads, so that minor's forms would reach a namespace pinned below it, whose strict parser refuses the
  whole manifest and every later republish. A form newer than 0.6 deploys only to a namespace at `--proxy-source=current`.
- **Steps off the paved road are in the reviewed snapshot, never refused by it (`diff.ts`).** Three kinds only: the
  reach a staged-kit site declares (`ContractArtifact.declared`: `sql`, `unscoped`, `connect`, `issues`), the SQL
  statements of the server modules once a site declares `sql` (`AccessSnapshot.sqlStatements`, below), and the
  database code the migrations declare (`AccessSnapshot.databaseCode`, from `classifyMigrations` of
  `@fabrika/platform-node/sql`, the runner's own classifier, over every file under `db/migrations/`, in the provider's
  `applicationDialect`). A site is keyed by
  its endpoint id or `job:<name>`, a database object by file, kind and object, never by line, so a moved handler is no
  change. A new site, table, connector, mount or object, `read` → `write`, an edited file holding code, and a contract
  that leaves the staged kit widen with `review: 'closer'`; removals narrow. `databaseCode` is absent when empty and
  the digest appends it only when present, so stored digests stay valid. A refused statement in a file the environment
  has not published unchanged fails the read (`migrations-refused`, a count, never the statement), as the runner
  refuses it. Checker structure hints never enter the snapshot. `AppEnvDto.deviationSubjects` lists the published
  snapshot's, grouped by site and migration, and `AppEnvDto.surface` (`surface.ts`) its endpoints under their most
  exposed caller, in `diff.ts`'s words.
  `sqlStatements` holds every tagged template of `src/` (tests excluded), since `ctx.sql` may be held under any name
  (`readSqlStatements` of `@fabrika/check/contract`, this release's, whatever the application pins), by file, line and
  the SHA-256 of its text as written (whitespace may stand in a quoted literal or end a `--` comment); a module the parser
  refuses is one entry, line 0, over its whole text. It is present, even empty, whenever a site declares `sql`, and
  absent otherwise. A new, changed or removed statement, matched by file and text, is an `off-road` closer-review line
  (`application.sql-statement`); a side without the field (read before this release, or no `sql` site) shows none. The
  digest appends the statements, without their lines, only when there are some, so a stored snapshot keeps its digest;
  a fresh read of a commit that runs statements digests apart from what an older release read
  (`framework-compat.test.ts`). It stays in the publication: it is the next deploy's baseline, so a Control rolled
  back below this release cannot parse a publication that records it.
  `AppEnvDto.accessMap` and the approval detail's `ApprovalDto.accessMap` (`access-map.ts`) read the same snapshot by
  role: each role's actions, and once per action its endpoints, tables and member or link reach. They are additive
  fields; a console reads their absence as an older Control.
- **A migration the environment applied, changed in the commit, fails the snapshot read before the build
  (`AppliedMigrationsChanged`, `read.ts`).** Applied means the stored snapshot of the environment's last succeeded run
  (`appliedMigrations`, `publish.ts`, which `unheldDataChanges` reads too), never the publication: a publication
  precedes the provider, so a file whose deploy failed may still change. Files compare as the runners compare them: the
  SHA-256 of the text, byte for byte (the snapshot's checksum is `migrationChecksum`'s), only `.sql` directly in
  `db/migrations`. One exception: the commit's `TextDecoder` drops a leading UTF-8 BOM, which the Postgres runner's
  `readFileSync` keeps, so a BOM-only edit passes Control and the runner refuses it. Keep the decoder: keeping the BOM
  would change the stored checksum of every such file and refuse it on the first deploy after an upgrade; a recorded file the commit no longer holds passes, as both runners tolerate it. Each file is one
  `access:` line in the run log, and the run fails naming them. A dev bootstrap (its sandbox's database is not the
  environment's) and the re-read of a stored candidate compare nothing. A file applied by a run that failed later, or by
  one before any succeeded run stored a snapshot, is left to the runners' own check (Postgres `verifyChecksums`, SQLite
  `verify`). The record can be ahead of the database (one reset outside a run, a Cloudflare object not yet booted on the
  version without the barrier): there Control refuses an edit the runner would take. The approval diff's "Migration … changes" line remains for a file published but
  never run.
- **An opaque root is derived from the artifact, never a field of it (`opaqueRoots`, `diff.ts`).** A root dimension
  (`in: null`) that no `dimension`-mode table owns has no row to check a value against: an application-wide grant admits
  any well-formed value, as `boot` derives it from the same `tables`. The diff shows one becoming opaque as a widening
  and one gaining its table as a narrowing; the surface notes it on every endpoint that takes its value (`in`, or `on` an
  input field). Every reader's artifact already states it, so no digest moves and an unchanged deploy shows nothing.
- **An environment's approval categories are stored as their difference from the defaults** (ADR-0083,
  `src/approval/categories.ts`): `app_envs.approval_categories` (and `app_env_protection`), null = the defaults, set
  only through `apps.environments.protect`. A classification stores its categories only when they are not the defaults,
  so an older Control still reads a default one. Every protection change sets IAM's gates for `<app>@<env>` (whether
  grants wait, and the `credentials` mode, `iamGatesOf`) with the provisioning key when Control can reach IAM (choosing
  `grants` without it is a 503), under the environment's deployment lease, at the environment's `protection_revision`,
  the stricter side first, gate by gate: the stricter of before and after into IAM before Control's row, the looser
  after it. A failed Control write never reverts IAM (the caller may have lost the lease); the next protection change
  repairs it, and IAM ignores an older revision. A new environment's gates reach IAM before its row
  (`writeNewEnvironmentGates`, from `apps.register` and an `apps.environments.put` that creates one), as it starts
  (`getStartingProtection`); one that starts protected is not created when IAM does not take them, or answers a looser
  `credentials` mode it holds, a later revision kept (503). An IAM older than the mirror answers no mode, holds none and
  reads every environment as `person`, so its answer is not compared. The maintenance
  pass (`convergeIamGates`, `src/approval/iam-mirror.ts`) writes up to 200 environments whose `iam_gate_mirrors` row is
  missing or names another revision, which converges an upgraded installation, a new environment whose write failed and
  a failed write after Control's row. It records an environment only when IAM answers the revision and the mode it
  sent; `GrantApprovalPort.set` parses IAM's answer. An IAM older than the mirror refuses `credentials` as an unknown
  key: the port writes the grant gate again without it, and from then on writes without it and logs one line (once per
  port, which the pass builds once per pass), and its answer carries no mode, so nothing is recorded and the pass writes
  the mode once IAM takes it.
- **Only a person in the console approves (`src/approval/api.ts`).** `approvals.complete` and
  `apps.environments.protect` need `access.approve` at the coordinates (outside `deploy.*`) from a `user`
  principal with no OAuth claims, no link claims and no `Authorization` header (`src/approval/human.ts`); the
  proxy admitted the session's POST from the console itself. The decision is written under the run lease
  (a busy environment answers 409); it is never an unfenced run write. Runs record their actor (`runActor`).
  Deleting a protected environment, or an app with one, takes the same human (`requireHumanForProtectedDelete`,
  over `RegistryUseCaseContext.admission`). A manual run of a protected environment is a person's only from the
  console (`isConsolePerson`: `isPerson` and no `Authorization` header); every bearer, a person's own `px_` key
  included, is a non-person, judged by `deploy-request` (`protectedRunDecision`): `refuse` is a 403, `off` runs, and
  `person` takes a 40-hex SHA and makes the run a request (`src/approval/request.ts`: who asked and the commit message
  in `runs.request_json`; under `deployRequestCommits: merged` the source must show the commit reachable from the
  trigger ref, or the default branch for a pattern, and a source error is a 400). A workspace ref is refused to
  everyone. `createManualRun` decides it (`protectedDeployOf`, shared by `triggerDeploy` and `deploy_stage`) after
  `deploy.trigger`, so a caller without it still gets the 404, and records `runs.by_person`; `deployUnder` decides it
  again when a manual run starts, from `startedByPerson` (the column, or the actor's `user:` prefix on an older row),
  and fails the run into its log. Once the provider resolved the commit, `deployUnder` also runs
  `assertManualCommitReachable` for every manual run of a protected environment, a person's included: the commit must be
  reachable from `mergeTarget` (always a full ref; `reachableFrom` refuses a short name, which GitHub may resolve to a
  same-named tag) through `deps.commits`, or the run fails before anything publishes (a request under
  `deployRequestCommits: any` skips it). A request parks whatever its lines (`park_reason = 'requested'`). A park sets
  `approval_deadline` (`requestTtlHours`); approve and reject check it in their own conditional write (410 past it), and
  `sweepParkedRuns` in the maintenance cron fails a run past it (`failure_cause = 'expired'`) and gives a run parked
  before the column its deadline. `approvers: 2` on any waiting category (`waitingCategoriesOf`) makes the first
  approval partial (`partial_approval_json`) and a different person's complete it. A restore's own deploy is exempt:
  it redeploys the running commit, and the restore's record names the run (`RestoreRepository.namesRun`), so an
  approved restore deploy queued again stays exempt. The settings (`approval_settings`, their difference from
  `STRICT_SETTINGS`) live beside `approval_policy`, on `app_envs` and in the `app_env_protection` tombstone.
  `requirePersonToPointTriggerRef` keeps a key from naming a protected environment's trigger ref (also on a new one that
  starts protected, through `put` or `register`), `requirePersonToPointDomain` from naming its domain (`put` and `register`;
  clearing it stays open), `requirePersonToPointPublicOrigin` from changing its public origin (`put` and `register`; IAM sends a
  scope-value key there, ADR-0085 §4), and `requirePersonToRedirect` from changing any field of `apps.update`
  on its app (ADR-0050 §4); each lets an existing environment whose `registry` mode is `off` through (`gatePasses`), as
  the gate did. `apps.update` writes only the fields that change, and a key's write is conditional in SQL on the
  protected environments it judged, at their generations (`updateApp` with `protectedAt`). The flag and the counters outlive the row in `app_env_protection`; a
  change of the flag bumps `protection_revision` and `generation`, and a registry write bumps `generation`, so an
  in-flight publication loses. Registry put and delete apply only at the generation they read (409 otherwise), and
  every write of an environment takes its coordinate lock first (`DATABASE.md`). `apps.environments.protect` takes
  the environment's deployment lease and answers 409 while a run holds it or is still `running`.
  `requesterMayApprove: false` on any waiting category (`requesterMayApprove` in the contract) keeps the requester's
  person from approving a parked deploy request (`requireOtherThanRequester`); where that person is unknown (a service
  key's issuer, which no token names) nobody approves it, and anyone may refuse it.
- **A decision under `stepUp: webauthn` carries a step-up challenge the person answered on IAM's page and IAM verified (ADR-0050 §5, `src/approval/step-up.ts`).**
  `requiredStepUp` on the waiting categories decides it, beside `requiredApprovers`. Control builds the binding from the
  stored item and the decision (`runStepUpBinding`, `requestStepUpBinding`), never from the input, and calls IAM's
  `passkeys.challenge`/`verify` over `IAM_ADMIN` with the caller's `X-Fabrika-Token` (`iamPasskeyStepUp`), no other
  credential. `requireStepUp` runs before any decision write and refuses (403) a missing or unanswered challenge, any IAM
  refusal or failure, and a verified person other than the approver. The passkey is recorded on the decision (the run's approval
  JSON, the request's `*_step_up_*` columns) and in its audit row. A change of protection that
  `weakensStepUp` (against the row read under the lease) takes one too: `apps.environments.protectChallenge` issues it on
  `protectionStepUpBinding` (the environment and the digest of the change as asked), and `protect` runs `requireStepUp`
  before IAM's grant gate and the row are written, recording the passkey in the `access.protect` audit row.
- **A non-person's direct write meets the gate before its use case (D8, ADR-0083 §3, `src/approval/requests/route.ts`).**
  Every `secrets`, `variables`, `data` and `registry` mutation of the router runs through `gateDirectWrite` with its
  category and coordinates (the all-environments layer and `apps.update` as `ALL_ENVIRONMENTS`): a person in the
  console, a reach with no protected environment, or `off` everywhere applies; `refuse` anywhere is a 403 naming the
  category; a write whose kind's `unchanged` holds over the before-state read now (the environment put, `apps.update`,
  a variable put; never a secret) applies as under `off`; otherwise `createApprovalRequestUseCase` stores the
  procedure's input as that kind's request and the call
  answers 409 `approval_requested` (`ControlApiError` with `data` `{ id, url, state, fingerprint? }`, the link in the
  message), never 200. A new environment has no request to wait in: a write whose environment does not exist but
  `startsProtected` (`prod`, or a kept protection) is a 403 for a non-person, and `register` keeps the person rules
  above. Anything else the write names that does not exist goes to its use case, which answers the 404.
  `approval-gate-coverage.test.ts` dispatches each judged mutation under `refuse`.
- **Every other action of a non-person that waits is an `approval_requests` row (ADR-0083 §8, `src/approval/requests/`).**
  A kind (`kind.ts`, `requestKind`) owns its input and before-state schemas, its coordinates, the action the requester
  must hold to ask, its execution, its `follow` hook, and an optional `discard` hook that releases what a refused or
  closed request held. `PRODUCTION_REQUEST_KINDS` (`production.ts`, kinds in `kinds/`) holds Control's local writes,
  each executing through the use case its procedure runs, as the approver, and an agent's grant (`kinds/grants.ts`),
  which IAM's administrators of the application decide and which executes as the approver's console grant over
  `IAM_ADMIN` with their console token (`requests/iam.ts`; the provisioning key only reads, to bind and to follow); a write that reaches the provider answers
  400 at creation, and a secret value is sealed under the request's purpose (`kinds/secrets.ts`). The all-environments
  layer is `env = '*'` (`ALL_ENVIRONMENTS`), a name `put` and `register` refuse to a new environment (`assertNewEnvironmentName`); `rules.ts` judges it by the strictest protected environment. Its decision and the sweep hold the
  lease of every environment it reaches and `<app>:*`, the row's fence, all or none (`acquireRequestLease`). `refused.ts` names the procedures no request may name, with why. Creating is a bearer's
  only (a console person gets 409). Every transition is one conditional update on the state it leaves
  (`ApprovalRequestRepository`), the decision checks the deadline in the same write, and every write from the final
  approval on is fenced on the environment's deployment lease, which the decision holds through the execution.
  `executeApprovedRequest` judges the policy and the before-state again (either closes it `stale`), records the
  operation id before the kind acts, and leaves a throw `unknown`; `sweepApprovalRequests` (cron, after
  `sweepParkedRuns`) expires pending rows past their deadline, closes an approved row that never started `failed`,
  follows `unknown` ones through the kind, and deletes a request's sealed copy
  (`platform:approval-request:<id>` in the vault) whose request is closed or absent, once older than the longest wait
  plus an hour. A decider holds `access.approve` at the coordinates, or what the kind's
  `approverMayDecide` seam says (an IAM action); only a reader who also holds the kind's action (or its decider seam) is
  shown the before-state, a value, a fingerprint or the result (`describe` gets `before: null` otherwise); `approval-gate-coverage.test.ts` lists the create and decide procedures as exempt.
- **A key an agent asks for (`kinds/keys.ts`, `iam.apiKeys.provision`, `credentials`) reaches Control only encrypted to the
  agent's public key.** IAM's installation administrators decide it; the approver must hold every action of the key in
  Control (`refuseApprover`), and under `credentialCeiling: requester` the requester too, from its token at creation.
  IAM issues it as the approver (`apiKeys.provisionRequested`, keyed by the request id, so `follow` reads it back by
  that id) and answers a JWE. The JWE waits in `approval_request_deliveries` until `fetchKey` hands it to the requester
  once (`isRequester`) and clears it; `sweepUnfetchedKeys` (cron) clears one past its deadline and revokes the key in
  IAM. The JWE is never in a DTO, an audit row or a log line.
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
