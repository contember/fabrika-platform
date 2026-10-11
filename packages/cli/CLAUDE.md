# @fabrika/cli

The single public `fabrika` executable. It parses the top-level `platform`,
`app`, `namespace`, `control`, `builder`, `db`, `job`, and `connect` command areas, resolves one provider where a
command has one, then delegates to an installation or provider package. It
contains no provider implementation. The one exception is `src/namespace.ts`:
`fabrika namespace` is a Control RPC client over the Zerops namespace planner,
so it lives here and `provider-zerops` does not depend on `control-contract`.

## The `control` area

`src/control.ts` is the operator's non-browser client for the Delivery control
plane ([ADR-0033](../../docs/decisions/0033-operate-the-control-plane-from-the-cli.md)).
It is the ONE area that resolves no provider and loads no installation module,
because the control API is provider-neutral. `--provider` reaches it only to
label the envelope a registration carries.

- It adds no server surface: every verb is one procedure of `ControlRpcContract`,
  called through the same `createRpcClient` the console uses. A procedure is
  reachable from both clients or neither.
- Output contract, as in `zops`: stdout carries DATA ONLY, progress and errors go
  to stderr, `--json` prints the result verbatim.
- Credentials come from the ENVIRONMENT ONLY and have no flag, so they cannot
  reach a CI log or a process listing. The origin is not a credential and takes both.
- `control key issue` is the bootstrap: a fresh installation's provisioning key is
  held in env and never in the DB, so the proxy — which resolves bearers through
  IAM's `mintFromKey` — cannot admit it. The command mints a DB-backed key instead.
  `--expires-in` is required and at most `MAX_KEY_LIFETIME_SECONDS` (30 days), the
  bound IAM enforces; the CLI checks it first only to say so before the call.
  `FABRIKA_IAM_RPC_URL` is IAM's PUBLIC origin; the private hostname services use
  between themselves resolves only inside the provider's project, so the help text
  and the unreachable-IAM message both say so.
- `namespaces create` commits the plan it just read, never a second derivation —
  the console's two-step form has the same rule for the same reason.
- `apps variables` writes an app's operator-set values, and a name the app's
  artifact does not declare is REFUSED rather than stored
  ([ADR-0035](../../docs/decisions/0035-the-platform-owns-the-application-iam-issuer.md)).
  A platform-owned name — the IAM issuer, the release, the Operations keys — is
  refused too: the deploy writes those.
- `register` CREATES; a changed manifest goes through `apps environments put`,
  which replaces one environment's envelopes and clears every placement field
  left out. Both are one procedure of the contract, so neither invents a merge.
- `app register` compiles the manifest in memory and sends the create-only request `register`
  builds (`registerCompiledManifest` in `src/control.ts`). The router loads the app code in the `app`
  area — provider inference included — and hands over only the provider and the compiled text; the
  `control` area still loads no app code. That code can read the environment, so either phase's
  message has `FABRIKA_CONTROL_KEY`'s value cut out before it is reported.
- **Do not add source-connection verbs.** Creating a GitHub App connection needs a
  human principal (ADR-0029); the console owns it.

## The `db` area

`src/db.ts` serves an application's Postgres schema, run from the application root
([ADR-0017](../../docs/decisions/0017-service-owned-postgres-migrations.md)). It resolves
no provider. The runner is `@fabrika/platform-node`'s application wrapper and the
renderer is `@fabrika/db/codegen`; this file only parses arguments and reports.

- `db new <slug>` writes `db/migrations/<UTC YYYYMMDDHHMMSS>_<slug>.sql`, the name the
  checker's `migration-name` rule accepts, and never overwrites.
- `db migrate` is the template's `run.initCommands` entry. It validates the files before
  it connects, then runs the wrapper's `migrate`: the provisioning credential
  `FABRIKA_APP_DATABASE_URL` creates and checks the role family, and the files are applied as
  the migration role `app_<id>` over ONE connection (the advisory lock is session state)
  (ADR-0017). It applies the framework's tables (`@fabrika/db/migrations`, bundle `fabrika`)
  before `db/migrations/`. `codegen` reads the catalog with the provisioning credential.
- `db codegen [--verify]` writes `src/db/schema.generated.ts` from the migrated schema;
  `--verify` writes nothing and fails when the file differs.
- `db test-scaffold` writes `@fabrika/check`'s `generatedTests` of what `scaffoldInputs` reads (the checker's own
  read of the contract and `src/db/tables.ts`) and deletes a generated test it no longer writes; a hand-written test
  is never touched. It connects to nothing. `src/__tests__/fixtures/isolation-app/` is an application whose
  generated tests are committed and run with this package's suite; `db.test.ts` fails when they differ from what the
  scaffold writes, and when its `schema.generated.ts` differs from codegen's.
- `db test-isolation` is the platform's run of them (the Zerops start script): the files must equal the scaffold's
  output and no endpoint may lack its input fixture, then `bun --config=<empty> test
  --preload=<@fabrika/app/testing/preload> <files> --reporter=junit` runs them, as a throwaway provisioner
  `createTestProvisioner` makes from `FABRIKA_APP_DATABASE_URL` and drops afterwards (the tests load application code,
  so they never get the provisioning credential itself), with
  `FABRIKA_TEST_POSTGRES_REQUIRED=1` and no framework variable, and every case name the scaffold wrote must be
  reported as passed with an assertion (`junit.ts`). The application's `bunfig.toml` (a preload, a root) never
  applies. **It prints none of the child's output**, only the counts and the failed case names, which come from the
  scaffold: a dependency may write a credential into the output in any form. `--verbose` prints it, locally only;
  the start script never passes it.
- `FABRIKA_APP_ID` and `FABRIKA_APP_DATABASE_URL` come from the ENVIRONMENT ONLY.
  An error reaches the output only as the runner's own message or a server-reported
  Postgres error; any other driver error is replaced, because it may quote the URL.

## The `job` area

`src/job.ts` runs one `c.cron` job of a contract application: `fabrika job run <name>`, the command every crontab
entry runs (the platform's generated crontab and the template's checked one). It resolves no provider. The run is
`@fabrika/app/bun`'s `runContractJob`, which boots the application like the server; this file only parses
arguments and reports.

- Run from the application root; it refuses a directory without `fabrika.contract.ts`.
- One line to stdout, exit 1 when the job failed, 0 when it succeeded or another run holds the lease. The process
  exits when the run ends, so nothing a handler left running outlives it.
- Handed `FABRIKA_APP_DATABASE_URL`, `runContractJob` runs the command again as the runtime role (the launcher, as
  the server's); the job runs in that second process.
- A failure prints its fixed code. Only an `instanceof` `BootError` or `JobError` keeps its message; any other error,
  whatever its name, is `boot_failed`, because its name or message may carry a secret or `FABRIKA_APP_DATABASE_URL`.

## The `connect` area

`src/connect.ts` vendors another application's export into the consumer's
`fabrika/connect/<app>.<export>.v<version>.ts`, from the description the owner's environment approved, as Control's
`connectors.describe` answers it (`POST <control>/api/rpc`). It resolves no provider. The snapshot source is
`@fabrika/app/contract`'s `snapshotSource`; this file only fetches, checks and writes.

- `connect add <app>/<export>@<version> --consumer=<app> --env=<env>` writes a new snapshot and never overwrites;
  `connect pull` with the same arguments rewrites an existing one and says whether the digest changed. Control's
  origin is `--url` or `FABRIKA_CONTROL_URL`.
- The Control key comes from `FABRIKA_CONTROL_KEY` in the ENVIRONMENT ONLY and is the only bearer sent; it needs
  `deploy.read` on the consumer. No message carries it, nor the answer's body. The origin is https, plain http only
  for `localhost`. Nobody sets an import's `FABRIKA_CONNECT_<IMPORT>_*`: Control writes them when it deploys the
  consumer.
- A description is written only when `parseExportDescription` accepts it — its digest is the digest of what it
  describes — and it names the requested `<app>/<export>@<version>`. A redirect is an error and never
  followed (`redirect: 'manual'`); the body must be `application/json` and at most
  `CONNECT_LIMITS.maxDescriptionBytes`; a body that contains the key is refused, so it never reaches a
  committed snapshot.
- Every diagnostic is fixed text, a top-level field and zod's code at most, never what the owner wrote; the
  key is cut out of every error and line regardless.
- stdout carries the snapshot's path; what to add to the contract and to `implement()` goes to stderr.

## The `app` area

- `app build` writes `fabrika/entry.generated.ts` (`@fabrika/app/build`) when
  `fabrika.contract.ts` sits next to the config: the Bun entrypoint on Zerops, then
  the provider's build; the Worker entrypoint on Cloudflare, and nothing else. An
  application without a contract builds as before.

## Provider selection

- App commands first use `--provider`, then inspect the default-exported
  provider-authored `fabrika.config.ts`.
- `authoredAppProvider()` reads the provider identity attached by that
  provider's `defineApp()`.
- Platform commands use the same resolver. Pass `--provider` when the working
  directory has no provider-authored app config.
- `cloudflare` and `zerops` are built-in aliases for `@fabrika/provider-<cloud>/installation`. Any other value is
  loaded as a package specifier implementing `@fabrika/provider-contract/installation`.

## Invariants

- Keep `fabrika` as the only public operator executable.
- Do not add provider-specific public executables.
- `fabrika-cloudflare-executor` is internal to the runner container.
- Keep command routing thin. Provider behavior belongs in the provider package
  or its `/installation` subpath.
- **How WIDE a platform command is, is the provider's answer, not this package's**
  ([ADR-0027](../../docs/decisions/0027-platform-deploy-is-as-wide-as-the-provider-needs.md)).
  Zerops' `platform deploy` owns a whole ordered sequence; Cloudflare's composes
  one runner/control pair and the scaffolded workflow keeps the order. `--help` on
  a platform command therefore prints the INSTALLATION's usage — that text is the
  provider's real surface, and on Zerops it is what an operator's workflow is
  generated from.
- Do not add a closed provider union to a shared contract.
