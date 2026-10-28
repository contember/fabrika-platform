# @fabrika/cli

The single public `fabrika` executable. It parses the top-level `platform`,
`app`, `namespace`, `control`, `env`, `builder`, `db`, `job`, and `connect` command areas, resolves one provider where a
command has one, then delegates to an installation or provider package. It
contains no provider implementation and never branches on a provider id. `src/namespace.ts` is the Control RPC
half of `fabrika namespace`: the provider's `NamespaceCli` plans and builds the namespace, this package holds
Control's origin and credential, calls it and prints, so no provider depends on `control-contract`.

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
  to stderr, `--json` prints the result verbatim. An empty list prints no row and says
  so on stderr. A `failed` namespace or run is an answer, not an error: the exit code
  stays 0 and stderr names the command that follows up (`namespaces reconcile`, `runs log`).
- Credentials come from the ENVIRONMENT ONLY and have no flag, so they cannot
  reach a CI log or a process listing. The origin is not a credential and takes both.
- `connectControl` is the one Control client, shared with the `env` area. It parses the origin before the key goes
  anywhere: `https:`, or `http:` to `localhost`, `*.localhost` (RFC 6761 loopback), 127.0.0.0/8 or `[::1]` only, and scheme, host and port alone (no
  userinfo, path, query or fragment). It follows no redirect. A JSON answer that carries `FABRIKA_CONTROL_KEY`, also
  behind a JSON escape, is dropped whole, and every error the area raises has the key cut out (`withoutControlKey`).
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
- `apps secrets` writes an app's secrets, whose values are write-only. `put` reads
  the value from STDIN only (one trailing newline dropped) and refuses a terminal,
  an empty value and a `--value` flag, so a value never reaches argv or shell history.
  No verb prints a value: `list` shows scope, name and storage, and a refusal has the
  value cut out. A deploy that refuses a platform-owned secret name names
  `apps secrets delete` as the fix.
- `register` CREATES; a changed manifest goes through `apps environments put`,
  which replaces one environment's envelopes and clears every placement field
  left out. Both are one procedure of the contract, so neither invents a merge.
- `--cross-origin=<origin>` is the one REPEATABLE option (`Flags.repeated`; every other option keeps its last value):
  the flags given are the environment's whole cross-origin list on `register` and `apps environments put`. Unlike the
  placement flags, `put` without it keeps the stored list, and a lone empty `--cross-origin=` clears it; an empty one
  beside another is refused. Every option takes `=<value>`, which is why clearing is the empty value, not a `--no-` flag.
- `app register` compiles the manifest in memory and sends the create-only request `register`
  builds (`registerCompiledManifest` in `src/control.ts`). The router loads the app code in the `app`
  area — provider inference included — and hands over only the provider and the compiled text; the
  `control` area still loads no app code. That code can read the environment, so either phase's
  message has `FABRIKA_CONTROL_KEY`'s value cut out before it is reported.
- **Do not add source-connection verbs.** Creating a GitHub App connection needs a
  human principal (ADR-0029); the console owns it.

## The `env` area

`src/data.ts` reads and operates one application environment's data through Control
([ADR-0069](../../docs/decisions/0069-control-reaches-an-application-environments-object.md),
[ADR-0070](../../docs/decisions/0070-data-protection-of-an-application-environment-on-cloudflare.md)): `inspect`
(`data.view`, or `data.content` with `--content`), `maintenance`, `operations`, `recover`, `backups`, `backups schedule`
and `restore --at=<time>`, each one `data.*` procedure. It resolves no provider.

- It uses the `control` area's client (`connectControl`): the same origin rule, environment-only key, no redirect and
  dropped key-carrying answers. Every diagnostic has the key cut out.
- An answer is parsed before it prints: the view by `@fabrika/auth-core`'s strict `parseOpsView` / `parseOpsContentView`,
  an operation or a backup by a projection of its DTO's known fields (a field an older Control lacks gets a default
  only where the field is newer than the procedure) (ids are UUIDs, an error code is Control's
  snake_case rule, the coordinates are the ones asked about).
- Human output and every diagnostic have control characters removed but tab and line feed: the content view's boot
  failure text is the application's own. `--json` prints the parsed value.
- A 501 means the control plane's release does not offer the procedure: the command exits 1 and says retrying will not
  help. A failed or running operation is an answer: exit 0, and stderr names the follow-up command.

## The `db` area

`src/db.ts` serves an application's database schema, run from the application root
([ADR-0017](../../docs/decisions/0017-service-owned-postgres-migrations.md)). It resolves
no provider. The runner is `@fabrika/platform-node`'s application wrapper and the
renderer is `@fabrika/db/codegen`; this file only parses arguments and reports.

The dialect is `@fabrika/check`'s `applicationDialect`, read statically from `fabrika.config.ts` (`dialectAt`): an
application whose config default-exports `@fabrika/provider-cloudflare`'s `defineApp` is on SQLite, in its Durable
Object ([ADR-0065](../../docs/decisions/0065-an-application-on-cloudflare-runs-in-one-durable-object-per-environment.md)),
and every other one, a missing config included, on Postgres. On SQLite no command needs a database URL or
`FABRIKA_APP_ID`: `migrate` refuses, `codegen` runs the migrations in memory, and the generated tests run on
`@fabrika/db/testing-sqlite`. `db-cloudflare.test.ts` holds those paths and that a Zerops application keeps its own.

- `db new <slug>` writes `db/migrations/<UTC YYYYMMDDHHMMSS>_<slug>.sql`, the name the
  checker's `migration-name` rule accepts, and never overwrites.
- `db migrate` is the template's `run.initCommands` entry. It validates the files before
  it connects, then runs the wrapper's `migrate`: the provisioning credential
  `FABRIKA_APP_DATABASE_URL` creates and checks the role family, and the files are applied as
  the migration role `app_<id>` over ONE connection (the advisory lock is session state)
  (ADR-0017). It applies the framework's tables (`@fabrika/db/migrations`, bundle `fabrika`)
  before `db/migrations/`. `codegen` reads the catalog with the provisioning credential. On SQLite `db migrate`
  refuses and says why: the object applies the migrations itself when it boots.
- `db codegen [--verify]` writes `src/db/schema.generated.ts` from the migrated schema;
  `--verify` writes nothing and fails when the file differs. On SQLite the schema is the bundles the object applies,
  `SQLITE_FRAMEWORK_MIGRATIONS` then `db/migrations` (`applicationMigrations` of `@fabrika/app/build`, the files the
  build bundles), run in an in-memory database by `@fabrika/db/codegen-sqlite`.
- `db test-scaffold` writes `@fabrika/check`'s `generatedTests` of what `scaffoldInputs` reads (the checker's own
  read of the contract and `src/db/tables.ts`) and deletes a generated test it no longer writes; a hand-written test
  is never touched. It connects to nothing. The tests open the test database of the application's dialect
  (`@fabrika/db/testing` or `@fabrika/db/testing-sqlite`). `src/__tests__/fixtures/isolation-app/` is an application whose
  generated tests are committed and run with this package's suite, always on a copy in a private temporary directory
  (concurrent runs of the suite share the committed directory); `db.test.ts` fails when they differ from what the
  scaffold writes, and when its `schema.generated.ts` differs from codegen's.
- `db test-isolation` is the platform's run of them (a Zerops init command): the files must equal the scaffold's
  output and no endpoint may lack its input fixture, then `bun --config=<empty> test
  --preload=<@fabrika/app/testing/preload> <files> --reporter=junit` runs them, as a throwaway provisioner
  `createTestProvisioner` makes from `FABRIKA_APP_DATABASE_URL` and drops afterwards (the tests load application code,
  so they never get the provisioning credential itself; creating it sweeps the provisioners killed runs left behind,
  and the command prints their names), with
  `FABRIKA_TEST_POSTGRES_REQUIRED=1` and no framework variable, and every case name the scaffold wrote must be
  reported as passed with an assertion (`junit.ts`). The application's `bunfig.toml` (a preload, a root) never
  applies. A database at its connection limit (SQLSTATE 53300) is waited for when the provisioner is made and dropped;
  a failed run whose output names a refused connection (`reportsExhaustedConnections`) fails saying so, never as a
  count of passed cases (ADR-0043). **It prints none of the child's output**, only the counts and the failed case names, which come from the
  scaffold: a dependency may write a credential into the output in any form. `--verbose` prints it, locally only;
  the init command never passes it. On SQLite it makes no provisioner, reads no database URL and passes no
  `FABRIKA_TEST_POSTGRES_*` variable: the SQLite kit opens an in-memory database; the scaffold and JUnit checks are the
  same.
- `FABRIKA_APP_ID` and `FABRIKA_APP_DATABASE_URL` (Postgres) come from the ENVIRONMENT ONLY.
  An error reaches the output only as the runner's own message (a `PostgresMigrationError`, which every refusal of
  the bundle is: it names files, never a URL) or a server-reported Postgres error; any other driver error is replaced,
  because it may quote the URL.

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
- stdout carries the snapshot's path; what to add to `defineApp`'s `imports` and to each calling endpoint's `connect`
  goes to stderr.

## The `app` area

- `app build` writes `fabrika/entry.generated.ts` (`@fabrika/app/build`) when
  `fabrika.contract.ts` sits next to the config: the Bun entrypoint on Zerops, then
  the provider's build; on Cloudflare the Worker entrypoint, which exports `FabrikaApplication`, and
  `fabrika/migrations.generated.ts` (the `.sql` files of `db/migrations`, which the object applies when it boots), and
  nothing else. An application without a contract builds as before.
- `app dev` (`src/app-dev.ts`) resolves no provider: it loads `src/app.ts` with `@fabrika/app/bun`'s
  `implementationAt` and serves it through `@fabrika/app/testing`'s `devKit` (the test kit and its stand-in IAM), on
  a throwaway schema of `FABRIKA_TEST_POSTGRES_URL` (`@fabrika/db/testing`), or for an application on Cloudflare (the
  same `dialectAt` read) on an in-memory SQLite database of `@fabrika/db/testing-sqlite`, migrated from
  `db/migrations` and gone on exit (`app-dev-cloudflare.test.ts`). It is the kit and nothing else: never add
  a proxy rule, an IAM or a second enforcement decision here.
  - The seed (`src/app-dev-seed.ts`): `--seed=<module>`, or `dev/seed.ts` when it exists, default-exports a `DevSeed`
    that gets the kit before the first request. Its answer is parsed at the boundary: a persona is a person that kit
    made, a link is a local path. A seed that throws is printed whole, message and stack (the developer's code on the
    developer's machine), and so is what a job's handler threw (`revealHandlerErrors`); a wrong answer names the
    entry's position, never what the seed wrote. Nothing else of the application's errors is printed.
  - The outside (`src/app-dev-outside.ts`): `dev/dev.env` (`NAME=value`, no `FABRIKA_*`) sets the application's
    variables over the environment's; the dev outbox replaces the process's `fetch` for `DEV_OUTBOX_ORIGIN`
    (`https://outbox.invalid`) only, keeps each request's method, path, content type and body (never a header), and
    answers 200. The seed's second argument reads it (`outbox()`) and every message a job handed to the kit's mail
    stand-in (`mails()`). The mail view lists the stand-in IAM's invitations and the jobs' mail together, newest
    first; the dev outbox has its own section after it. A public procedure's challenge passes
    (`devKit`'s `passingChallenge`), and Turnstile's test-widget token passes at every submission
    (`TURNSTILE_TEST_TOKEN`); any other token is single use.
  - The routes under `/__fabrika/dev`: the picker, `as` (a persona, a role in a scope value, an accepted invitee, or
    anonymous; it sets the cookie the application never sees), `accept` (an invitation the stand-in IAM sent),
    `state` (the toolbar's JSON), `toolbar.js`, `outbox/<id>` (a captured request, as text) and `mail/<id>` (a job's
    message: its fields, its text, and its HTML in a `sandbox=""` `srcdoc` frame under the page's own CSP). Every `text/html` 200 of an SPA or link mount gets the toolbar's
    same-origin script tag; the kit's CSP already admits it, so `app dev` changes no header the kit answers.
  - The UI (`src/app-dev-ui.ts`) is self-contained HTML, CSS and a shadow-DOM script, colored by `--fd-*` custom
    properties, light and dark. The picker answers its own strict CSP and runs no script.
  - It refuses any host but loopback, answers 421 to a request whose `Host` is not its loopback name and port, and
    prints its address and the seed's counts only: no credential, link key or mailbox.

## Provider selection

- App commands first use `--provider`, then inspect the default-exported
  provider-authored `fabrika.config.ts`.
- `authoredAppProvider()` reads the provider identity attached by that
  provider's `defineApp()`.
- Platform commands use the same resolver. Pass `--provider` when the working
  directory has no provider-authored app config.
- A provider id (`[a-z][a-z0-9-]*`) names `@fabrika/provider-<id>`: platform commands load its `/installation`
  (`@fabrika/provider-contract/installation`), app and namespace commands its `/cli`, whose `appCli`
  (`@fabrika/provider-contract/app-cli`) declares the entry runtime, `build`, `deploy`, `registrationManifest` and
  `namespaces`. A command the provider does not declare is refused with its id. Any other `--provider` value of a
  platform command is loaded as a package specifier.

## Optional packages

`@fabrika/builder`, `@fabrika/provider-cloudflare` and `@fabrika/provider-zerops` are optional `peerDependencies`
(and workspace `devDependencies`), so an application installs only the provider its `fabrika.config.ts` imports.
Not `optionalDependencies`: an installer installs those regardless. Import them only with a dynamic `import()` in the
command that needs them, after `requireInstalled`, which names the package to add when it is absent. A static import
of one puts it back into every application's install; `scripts/__tests__/release-validation.test.ts` lists the
packages a Zerops application installs.

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
