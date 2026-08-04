# @fabrika/control

The control plane: registry + queue + encrypted vault, driving a deploy from a GitHub push, a manual
trigger, or a repo poll. It runs on **two** targets — a Cloudflare `WorkerEntrypoint` and a long-running
Bun process — from one shared body of code. Assumes the root CLAUDE.md.

Public control REST DTOs and `RunLogLine` live in `@fabrika/control-contract`.
Keep browser and runner consumers on that package instead of importing this
runtime package.

## Commands (this package)

```bash
bun run dev                                       # lopata dev on :18291 (DEV=true → dev-persona AuthContext)
bunx wrangler d1 migrations apply DB --local      # apply migrations to the local D1
bun run oblaka                                     # regenerate wrangler.jsonc (plan/dry)
bun run bootstrap                                  # deploy fabrika itself (needs real CF creds + env)
bun run seed                                       # register apps (single-account: no account registry)

# The Bun/Postgres target (see zerops.yaml)
bun run migrate:postgres                           # apply migrations-postgres/ (FABRIKA_CONTROL_DATABASE_URL)
bun run serve                                      # the long-running server (src/node/server.ts)
bun run maintenance                                # the cron one-shot: repo poll + stale-run sweep
```

Migration commands and the Postgres-backed test setup are in [`DATABASE.md`](./DATABASE.md).

`wrangler.jsonc` is auto-generated from `oblaka.ts` — DO NOT edit it by hand.

## Two entrypoints, one body of code

|                 | Cloudflare                                     | Bun process (Zerops)                                                |
| --------------- | ---------------------------------------------- | ------------------------------------------------------------------- |
| entrypoint      | `src/index.ts` (`cloudflare:workers`)          | `src/node/server.ts` (`Bun.serve`)                                  |
| HTTP            | `fetch()` → `controlApp`                       | `@fabrika/app/bun` → `controlApp`                                   |
| deploy consumer | `queue()` → `runDeployJob`                     | `PostgresJobConsumer` → `runDeployJob`                              |
| cron            | `scheduled()` → `runMaintenance`               | `run.crontab` → `src/node/cron.ts` → `runMaintenance`               |
| migrations      | `wrangler d1 migrations apply` (`migrations/`) | `run.initCommands` → `src/node/migrate.ts` (`migrations-postgres/`) |
| provider        | `@fabrika/provider-cloudflare` + `RUNNER_SVC`  | `@fabrika/provider-zerops` + neutral engine                         |

The shared layer is `app.ts` · `consumer.ts` · `cron.ts` · `services.ts` and everything they reach.
It imports only `@fabrika/provider-contract`. `src/index.ts` statically selects Cloudflare;
`src/node/provider.ts` statically selects Zerops. `entrypoint-isolation.test.ts` proves that neither
entrypoint reaches the other provider or runtime.

## Architecture

`fetch` routes: `/api/health` → ok · `POST /webhooks/github` → webhook ·
`/iam/admin/*` → transport-only IAM gateway · `/operations/api/*` →
transport-only Operations gateway · `/api/*` → ACL-gated control surface ·
everything else → dashboard `ASSETS`. `/healthz` is a liveness-only route on
the shared app and is exposed by both the Cloudflare and Bun compositions.
Neither gateway changes service ownership;
IAM and Operations authenticate, authorize, and audit their own requests. A
trigger writes a `pending` run to the
database then enqueues. The consumer resolves the statically selected `ControlProvider` and calls its
capabilities. Cloudflare hands the provider-owned job to vozka-runner. Zerops executes its provider
session in process. Core owns registry/run writes, locking, secret resolution, and generic envelopes.

Runtime surface: `src/env.ts` (ports + vars) · `src/platform-cf.ts` (the raw CF bindings + their
adapters) · `src/services.ts` (how every dependency bag is built). Persistence capabilities live in
`src/db.ts`; the runtime composition root assembles them over D1 or Postgres. Schema:
`migrations/*.sql` (SQLite/D1) and `migrations-postgres/*.sql` (the same FINAL schema, expressed once,
for Postgres).

Three deploy TRIGGERS, all converging on the same `createRun` + enqueue: (1) the GitHub-App push
webhook (`src/webhook.ts`, private repos); (2) the manual Deploy button (`triggerDeploy`); (3) the cron
poller (`src/repo-poll.ts`, wired in `scheduled`) for PUBLIC repos with no App install — it conditional-
GETs the repo's commits/tags Atom feed (ETag) and enqueues on a new head sha (`runs.trigger='poll'`).

An env's `trigger_ref` is an exact git ref OR a `*`-GLOB (`src/ref-match.ts` `refMatches`), most usefully
`refs/tags/v*` to deploy on every version tag. The DEPLOYED ref is always concrete — the pushed ref
(webhook) or the resolved newest matching tag (poll) — never the pattern. NULL trigger_ref = manual-only;
a glob trigger_ref falls back to the default branch for a no-ref manual deploy.

## Invariants

- **ACL on every `/api/*` route.** `controlApp` authenticates once through
  `@fabrika/auth` middleware; each handler then calls `authorize` with that
  resolved context and its action/scope. Actions/scopes live in `src/actions.ts`.
  The GitHub webhook (`src/webhook.ts`) is the
  ONLY unauthenticated route — HMAC-gated instead. IAM is the WHOLE front door now (native auth, no
  Cloudflare Access): `src/iam.ts` configures the public IAM SDK over `env.IAM` —
  a human via SSO (`px_session` → minted `px_token`) or a machine via an `Authorization: Bearer px_` key
  (gates: `CONTROL_GATES` = service + human) — then `can(action, scope?)` + audit. `env.IAM` is the
  `IamRpc` CONTRACT, so it is a service binding on Cloudflare and `HttpIamRpc` (`@fabrika/auth`, bearer
  `FABRIKA_IAM_RPC_KEY` against IAM's `/rpc/*` at the private `FABRIKA_IAM_RPC_URL`) in a process.
  `FABRIKA_IAM_URL` remains the public issuer. ONE instance per process, never per request:
  `PropustkaAuth` caches the JWKS in a WeakMap keyed by that object.
- **Local vs off-local auth by the `DEV` var:** `DEV='true'` → a fabrika-synthesized AuthContext from a
  fixed dev persona (no IAM service, selected by the `X-Dev-Principal` header / cookie); `DEV=''` →
  IAM-backed auth over `env.IAM` (needs `FABRIKA_IAM_URL` as the issuer). `FABRIKA_CONTROL_BOOTSTRAP_ADMINS`
  is the first-operator escape hatch — fails CLOSED on a malformed value.
- **The `px_token` cookie's `Secure` flag comes from `FABRIKA_CONTROL_DOMAIN`, never from the request protocol.**
  Behind a TLS-terminating L7 balancer the browser spoke HTTPS and the process sees plain HTTP, so
  `PropustkaAuth`'s default derivation would silently drop `Secure`. `secureCookies` (`src/iam.ts`)
  forces it whenever a public domain is configured. Widening only — the Cloudflare path is unchanged.
- **Vault (`src/vault.ts`): envelope AES-256-GCM**, KEK from `FABRIKA_CONTROL_VAULT_KEY` (never in D1, never logged).
  Secret VALUES are write-only over the API; D1 stores only ciphertext + wrapped DEK. Losing the KEK is unrecoverable by design.
- **Secrets resolve by ref scheme** (`src/secret-resolver.ts`): `vault:` / `secretstore:` / `env:` / `literal:`.
  An unknown / unresolvable ref THROWS — never deploy with an empty credential. The resolver handles ONLY
  per-app `pipeline.secrets`; platform creds are fabrika's own Worker config (below).
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
  and is projected unchanged to Operations. PUT omission preserves the stored
  value; explicit `null` clears it. Never derive it from a provider hostname.
- **Run lifecycle is status-guarded + idempotent** (`src/run-lifecycle.ts`): `markRunStarted` only moves
  pending→running, so a redelivered queue message is a no-op. ack handled runs; retry only on an unexpected throw.
- **The Cloudflare provider owns the runner boundary.** `CloudflareRunnerJob` and its validator live in
  `@fabrika/provider-cloudflare`; `@fabrika/runner-contract` contains only transport types and endpoint
  constants, `@fabrika/runner-container` owns the Bun process and image, and
  `@fabrika/runner-cloudflare` owns the executor Worker.
  The control plane has NO `Container` binding. The split exists because a deploy's final
  step runs `wrangler deploy` INSIDE the container, and when the target is fabrika that resets fabrika's DOs —
  so a container hosted in fabrika would reset ITSELF mid-deploy. Hosting it in vozka-runner means a fabrika
  deploy never touches it. As a consequence fabrika has no `Container` → no docker → it's deployable THROUGH
  the runner. vozka-runner ALSO writes the terminal run status→D1 (`@fabrika/runner-cloudflare`'s `finishRun`), a
  belt-and-suspenders co-write with `markRunFinished` made safe by the `WHERE status IN ('pending','running')`
  guard — whichever survives the deploy records the run. vozka-runner is deployed out-of-band (its own bootstrap).
- **Per-app-env deploy lock** (`@fabrika/platform`'s `SqlDeployLocks`, wired in `src/services.ts`; one
  `deploy_locks` ROW per `<app>:<env>`, NOT a DO — the implementation needs nothing but the `SqlDatabase`
  port, so it is portable and lives with the ports, not in this Worker):
  `executeDeploy` takes it before starting and releases it in `finally`, so two triggers can't deploy the
  same target concurrently (race on cf-state / wrangler / IAM). A contended run returns `deferred` —
  left `pending` and re-enqueued by the consumer with a delay (a fresh delivery, so the retry budget is
  preserved). The lease is non-reentrant + TTL-bounded (self-heals if a consumer dies) + holder-checked on
  release; `acquire` is ONE conditional upsert (`meta.changes` is the answer) so there is no read-then-write
  race, which is why it works identically on SQLite and Postgres. Never split it into a read + a write.
- **Never log a secret/credential** (see root). The run row is written before the queue is touched (durable trigger).
- **`fabrika.config.ts` is the source of truth** for fabrika's own resources; keep `oblaka.ts` a thin shim (see root).
- **The Zerops executor is injected.** `createZeropsControlProvider` requires an `execute` collaborator.
  `src/node/provider.ts` supplies `@fabrika/engine`; never add a provider-local fallback lifecycle.

## Patterns

- **Database access, dialect rules, and migrations: read [`DATABASE.md`](./DATABASE.md)** before
  editing `src/db.ts`, `migrations/`, or `migrations-postgres/`. It covers the ADR-0015 repository
  seam, caller-stamped timestamps, the int4-vs-BIGINT row-shape rule, and the ADR-0017 ledger.
- Errors via `src/http.ts` `error(status, msg)`; handlers return its Response. Unexpected throws → 500, never leak internals.
  On the Bun target that catch-all is NOT optional: `Bun.serve`'s default error page puts the exception
  AND the surrounding source lines in the response body, so `createFetchHandler` wraps every request and
  `Bun.serve`'s `error()` backstops anything raised outside it. Both answer a bare `internal error`.
- **The generated root `zerops.yaml` is the only platform build specification.**
  `packages/installation-zerops/zerops/setups.ts` owns the typed IAM, Operations,
  control, and proxy setups; do not add per-package
  `zerops.yaml` files.
