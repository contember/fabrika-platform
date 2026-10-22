# Local Zerops-targeted stack

The local stack runs Fabrika's real runtime components in Docker before a
credentialed Zerops deployment. It validates Fabrika behavior and network
boundaries. It does not validate Zerops infrastructure behavior.

## Prerequisites

- Bun with the repository dependencies installed
- Docker with Compose v2
- `cpu-lease`, used to build the unified console

## Commands

Run these commands from the repository root:

```bash
bun run local:up
bun run local:status
bun run local:smoke
bun run local:compat
bun run local:down
```

`local:up` generates stable local credentials, builds the unified console, starts the
composition, runs database migrations, waits for health checks, and provisions the
machine API key described below.

`local:smoke` is intentionally disruptive. It:

1. creates or reuses the cheap `apps-prod` namespace with shared PostgreSQL;
2. registers the notes app from its compiled Zerops manifest, bound to the keyed
   source connection `local-keyed-alpha` that owns its private repository;
3. signs a push with that connection's webhook secret, requires its scoped route
   `/webhooks/github/local-keyed-alpha` to answer 200 with exactly one triggered
   run, and waits for that run's external app-version id. Notes is a contract
   application: Control reads `fabrika.contract.ts`, the table policies and the
   migrations at the commit, and every access of that snapshot is new, so its first
   deploy to the protected `prod` waits for approval
   ([ADR-0050](../decisions/0050-approved-access.md)): the smoke signs in to the
   console through the real handoff (`LOCAL_DEV_LOGIN`) and approves it with
   `approvals.complete` from the console's origin, as a person does;
4. hard-kills control while the emulated pipeline is `BUILDING`;
5. starts control after the pipeline becomes `ACTIVE`, runs the maintenance cron until the dead
   holder's deploy lease expires, and verifies that it settles the run plus terminal release projection;
6. verifies the explicit notes `publicOrigin`, stable managed ingest
   configuration, one sensitive proxy secret on the app service equal to the
   namespace proxy's, a bucket marker naming the bucket the import created, and the
   version's generated run section (the release, the approved contract digest and
   the four storage references);
7. checks the reconciled IAM schema against the contract, that a path no endpoint
   serves stops at the proxy, a note created and listed through the endpoint
   table with a service key, and the proxy's CSP `connect-src` naming the local
   Operations ingest;
8. verifies that an anonymous console `/api/*` call is refused by the PROXY, that
   the public Operations hostname refuses health, catalog and release
   reconciliation and every operator route outright — with and without a machine
   credential, because it declares no rule for them — and that it rejects an
   ingest envelope without a source credential;
9. sends a credentialed Sentry envelope and observes one source-scoped issue
   after asynchronous Postgres queue consumption;
10. stops Operations, persists duplicate queued deliveries, restarts the real
    consumer, and proves stable issue identity, exactly-once counting, and queue
    drain;
11. proves the notes container cannot reach the private control or Operations
    networks.

`local:compat` is [ADR-0062](../decisions/0062-a-platform-release-serves-older-framework-releases.md)'s
compatibility suite on this stack; see [The compatibility suite](#the-compatibility-suite).

To discard all local databases, object data, emulator state, and generated
credentials, use:

```bash
bun run local:reset
```

This command removes only the `fabrika-local` Compose volumes and
`packages/local-stack/.state/`. It then creates and starts a fresh stack.

## Local object storage

SeaweedFS `chrislusf/seaweedfs:4.42` runs in `mini` mode as `object-storage`.
It creates `run-logs` and `operations-payloads` on startup. Health checks wait
for both buckets in the filer, not just the S3 port. Telemetry and implicit
bucket creation on upload are disabled.

Preparation writes `.state/object-storage-identities.json` from the matching
storage credentials in `control.env` and `operations.env`. Both buckets require
signed requests; there is no anonymous identity. Existing credentials, including
IAM keys, remain unchanged when this file is first generated or regenerated.
Fresh stacks do not need or generate `minio.env`.

SeaweedFS uses a new `object-storage` volume. The previous `minio` volume and
`minio.env` file are retained but unused. Existing MinIO objects are **not
migrated**: old run logs and Operations payloads are unavailable in the new store.
`local:up` and `local:down` preserve both stores. Only an explicit `local:reset`
discards all local data, including the retained MinIO volume and credentials.

## The Notes container

The `notes` service runs `examples/zerops-app` as the platform starts a contract
application on Zerops: the source's own `./node_modules/.bin/fabrika` runs `db migrate`, `db codegen --verify` and
`db test-isolation`, then the generated entrypoint
(`fabrika/entry.generated.ts`, which preparation writes, as the platform build does).
Preparation writes the variables a deploy writes: `notes.env` holds the database URL,
the proxy secret and the bucket credentials, `notes-contract.env` the digest of the
example's contract, and `apps-proxy-secret.env` the same secret under the apps proxy's
`proxySecretVariable('notes@prod')`. The apps proxy serves the contract's endpoint table
(`localAppsProxyManifest`), with the local ingest origin as its `operationsOrigin`, so its CSP lets
the browser report errors. The bucket `notes-files` is on `apps-storage`, a SeaweedFS
of the `apps-prod` network only, so the application never reaches the platform's
storage. A `.state` from before the contract application asks for `local:reset`.

Notes manages the members of a workspace (`people.guests.invite`), so a deploy also writes IAM's
membership transport: `FABRIKA_IAM_RPC_URL` (IAM's public origin) and the environment's
`FABRIKA_IAM_RPC_KEY`. `up` issues that key through IAM's `membershipKeys.issue` with the
provisioning key, as Control does, into `notes-membership.env` (`src/membership-key.ts`), after
IAM knows the Notes schema and before the container starts. Each issuance ends the environment's
other keys, so `up` keeps a stored key IAM still accepts, which after a deploy is the one Control records.

The database URL in `notes.env` is the `apps-db` superuser's, and it is only the
provisioning credential: `fabrika db migrate` creates the role family with it and
migrates as `app_notes`, the server connects as `run_notes`, and `local:smoke` checks
both ([ADR-0017](../decisions/0017-service-owned-postgres-migrations.md)). An
`apps-db` volume from before the role family holds an `app_notes` schema its
migration role does not own, which `fabrika db migrate` refuses; `local:reset` once
starts it over.

Nothing deploys the container, and the emulator runs no code. `followNotesDeploy`
(`src/notes-follow.ts`) makes the composition serve what the emulator's active Notes
version deployed: the endpoint table Control published on the namespace proxy, the
contract digest, workload keys and membership transport the deploy wrote, and the source of that commit. The
browser stack uses it: its `notes-agent-change` seed deploys and approves the pinned
commit, follows it, and pushes the agent change commit through the notes connection's
webhook, where it waits for approval. The scenario
`tests/browser/notes-agent-adds-endpoint-and-table.test.ts` approves it in the console and
follows the deploy. Every `up` returns the container to the workspace example.

Every prepare also builds the example's SPA (`dist/web`), which Notes serves at `/`. The
SPA's `FabrikaProvider` reads the managed DSN, release and environment from the framework's
`/__fabrika-config.json` and reports the page's uncaught errors there; the browser stack recreates Notes with the DSN of a
seeded Operations source, so `tests/browser/operations-sdk-ingest.test.ts` finds its events
there.

## Immutable source fixtures

Local preparation creates two deterministic Git repositories, the platform's from
`packages/local-stack/fixtures/source/platform/` and the application's from the complete
Notes example as its repository holds it, plus the entrypoint the build writes
(`applicationFixtureSource`). The application repository has a second commit on top of
that one, `agentChange`: an agent's change to Notes under the fabrika-app skill
(`fixtures/source/notes-agent-change.patch`) — the endpoint `api.notes.rename`, the child
table `note_labels` with its policy and migration, a migration that declares a trigger (database code, which the
approval marks "needs closer review"), and the regenerated code and tests. It also holds one commit per
release fixture, the example as a released tag holds it ([The compatibility suite](#the-compatibility-suite)).
`deployable.test.ts` checks the application and agent change archives as a production build does: the checker, and
on Postgres `fabrika db migrate`, `fabrika db codegen --verify` and `fabrika db
test-isolation`. Preparation stores their manifests and archives
under `.state/source-fixtures/`. Their commits do not depend on the enclosing
checkout's HEAD, index, or uncommitted files. Control receives the platform
fixture's immutable proxy source pin. Conflicting existing pins require an
explicit reset; preparation does not silently change a persisted namespace's source.

The local control process uses control's real in-process source and archive
admission (`packages/local-stack/src/control-server.ts`). Injected metadata/download
transports (`local-source-transports.ts`) serve only these exact fixture coordinates,
and each file of the application commit only when its bytes on disk still have the
pinned blob id (`readFixtureFiles`). The pinned tree is
`fixtures/source/manifest.json`: an edit of the example moves it, and `fixture.test.ts`
fails until `bun run fixtures:pin` (in `packages/local-stack`) regenerates it.
The double answers the application repository's `main` with the commit the last push
moved it to: `triggerByScopedWebhook` writes `.state/github-branch-head.json` before it
sends the push event, because Control resolves the pushed ref and refuses a different
commit than the event named.
The upload transport maps a capability-bearing logical Zerops HTTPS URL to the
private emulator endpoint. Production destination validation is unchanged, and
unknown coordinates or destinations have no network fallback.

The platform fixture is a public repository, as a namespace proxy source must be.
The application fixture is private: it belongs to `fabrika-local`, the installation
owner of the keyed connection `local-keyed-alpha`, and without an installation token
scoped to it every metadata and tarball request answers 404, as GitHub hides a
private repository. `local:up` generates one RSA key per fixture GitHub App into
`.state/github-apps.json`. The connection seed puts each key into Control's vault,
exactly where a console setup leaves it. The GitHub double (`github-double.ts`)
holds only the public halves. It verifies each App JWT against that App's own key
and lifetime, checks that the installation belongs to the App, and mints a token
scoped to the one requested repository. Codeload then takes a one-time query grant
from the tarball redirect, never the installation token. A seeded connection whose
key or coordinates differ from the fixture stops Control's start with a request to
reset the stack. A deploy of notes therefore exercises the whole keyed path:
credential selection by connection, the vault read, token minting, the private
resolve and archive, and a webhook delivery that reaches a bound application.

All of these transports are composition inputs of `createRuntime` in
`control-server.ts`. Production reads no environment variable that could move a
GitHub origin (ADR-0029); `fixed-origins.test.ts` in control pins that. The double
models GitHub's API contract, not GitHub: App setup, installation discovery and
webhook configuration answer 404, so the console's connection workflow still needs
a live installation.

The emulator models reservation, upload completion, build submission, activation
and cleanup for one version identity. Its persisted upload receipt stores byte
count and digest, not archive contents or bearer capability. Deleted reservations
cannot be resurrected by late uploads. It does not compile uploaded code: the
separately composed Notes container tests application and access behavior, while
the source fixture tests commit/digest/archive and lifecycle behavior.

## The compatibility suite

`local:compat` proves on the composition that this platform deploys and runs an application on an older framework
release, unchanged, and that the application's next deploy upgrades it on its own data
([ADR-0062](../decisions/0062-a-platform-release-serves-older-framework-releases.md)). It complements
`framework-compat.test.ts` in `packages/control`, which compares the readers, digests, rows and schemas without running
anything. For each recorded release (v0.6.0, v0.5.5, then v0.4.8; `bun run compat v0.6.0` in `packages/local-stack` runs one),
it:

1. drops the Notes schema and role family (`dropApplicationDatabase`), so the release's own framework migrates an
   empty database;
2. pushes the release's commit through the keyed connection's webhook. Control reads it with the bundled reader of its
   minor, the suite approves the diff in the console, and the deploy runs to the emulator. The composition follows it:
   the release's source with its packages installed from npm, the entrypoint its own framework writes, its own
   `fabrika` for the init commands, and the digest and endpoint table the deploy wrote. A healthy container means the
   release's startup digest check passed;
3. calls Notes through the proxy: a service key creates and lists notes, a path no row serves and a key without
   `notes.write` are refused with 403, an anonymous call is sent to sign in, and the local admin, signed in on the
   Notes host and granted the notes actions, uploads three files to the `attachments` collection, removes a fourth, and
   downloads each byte for byte. The collection's endpoints admit only people;
4. pushes the workspace example as the next deploy and prints its approval diff. The suite then checks the ledger
   (`fabrika/0008_files.sql` and both adoption migrations applied), lists and downloads the three files through
   `api.attachments.*` byte for byte, uploads a new one and removes another, ages every file past the one-hour pending
   grace, and runs `fabrika-file-sweep` in the container: it must keep every referenced file and delete the removed one.

A release fixture is the example as its tag holds it, recorded in
`packages/local-stack/fixtures/source/releases/notes-<tag>.json`, except its `bun.lock`: the example's own is the
standalone mirror's, so the record holds the one a `bun install` of the tag's pins writes from npm.
`bun run fixtures:release <tag>` (in `packages/local-stack`) records one, from the tag of the enclosing checkout; it is
committed because a CI checkout holds no tags. Each is a commit of the application repository of its own, pinned in
`fixtures/source/manifest.json` like the others, so a new record needs `fixtures:pin` and a `local:reset`.

The suite needs npm to install the release's packages. It ends with Notes on the workspace example, as `local:smoke`
expects it. It leaves the Notes database holding the suite's rows; `local:up` keeps them.

## Endpoints

| Component                | URL                                      |
| ------------------------ | ---------------------------------------- |
| Unified Fabrika console  | `http://control.fabrika.localhost:18080` |
| IAM auth and public JWKS | `http://iam.fabrika.localhost:18080`     |
| Operations public ingest | `http://errors.fabrika.localhost:18080`  |
| Notes example app        | `http://notes.fabrika.localhost:18081`   |

## Signing in

The proxy is the only front door locally, exactly as it is in a deployed
installation. It fronts each host with the SAME declarations a deployed proxy
carries, imported rather than copied: the console by its service table
(`packages/control/fabrika.service.ts`), the public Operations host by
`OPERATIONS_PUBLIC_SERVICE` (`packages/operations/src/service.ts`), and IAM by its
own service table (`packages/iam/src/service.ts`), every row `protocol` because it
authenticates itself. Every prepare writes `.state/control-table.env`: the
`FABRIKA_SERVICE_TABLE_DIGEST` of the console table the proxy publishes, from
which Control reads whether it serves MCP.
The platform Caddy generator receives IAM's trusted issuer and private upstream
as `iamSessionOwner`. Only that exact route retains IAM's `__Host-px_session`;
all other Fabrika cookies are removed, including handoff verifiers. Application
upstreams retain no Fabrika cookies. Zerops builds receive the same owner through
`FABRIKA_PROXY_SESSION_OWNER_JSON`; namespace proxies and first-pass installation
explicitly supply `null`.
Nothing reaches an application until the proxy's endpoint decision admits it, and
the application only ever verifies the token the proxy injected. There is no second way in: `@fabrika/auth`
has one code path and no local mode, so no synthetic persona exists anywhere.

Opening the console therefore runs the real round trip:

1. the proxy selects the console's row, which admits `human`, finds no session and answers `302` to
   `iam.fabrika.localhost:18080/auth/login?app=vozka&redirect=<original URL>&state=…&code_challenge=…`,
   after storing the verifier in a short-lived cookie on the console host;
2. IAM authenticates. `LOCAL_DEV_LOGIN=true` makes that step non-interactive: IAM
   creates a **real** session row for the `admin@local.test` bootstrap admin
   instead of calling an external IdP. It is IAM's own mechanism and is refused at
   use the moment the flag is off;
3. IAM issues a single-use code bound to `(session, vozka, return URL, challenge)` and 302s to
   `control.fabrika.localhost:18080/__fabrika/auth/callback?code=…&state=…`;
4. the proxy there redeems the code with the browser-held verifier, sets `__Host-px_session` **on the console's own
   host**, and 302s to the original URL. Every later request mints a per-app token
   from that cookie.

That session is a **global admin** — `LOCAL_DEV_LOGIN` resolves the fixed
`admin@local.test` bootstrap admin and nothing else. Everything else about an
identity is done in IAM, through the console's Access plane: `principals.invite`
creates one, and `passwords.issueEnrollment` mails the enrolment link — that
principal can then sign in with a password.

Mail is captured, not delivered: each message is a JSON file in
`packages/local-stack/.state/mail/`, keyed by the idempotency key the transport got. The
composition holds one transport, the `x-local-mail` set of `compose.yaml`:
`FABRIKA_EMAIL_PROVIDER=directory` and `FABRIKA_EMAIL_DIRECTORY`. Control and IAM hold it,
and each accepts that provider only because its local server registers it
(`LOCAL_EMAIL_PROVIDERS`, `src/mail-capture.ts`).

Control's mail relay writes the files ([outbound email](outbound-email.md#the-relay)). IAM
runs `packages/local-stack/src/iam-server.ts`, the production server, with
`FABRIKA_CONTROL_URL=http://control:3000`, so it hands each message to the relay as it does on
Zerops. So forgot-password, invitations and an administrator's enrollment and reset all work
here, and the console's Mail page lists every message.

An application's mail lands in the same directory. A deploy of an application on framework 0.7
whose job declares `mailer: 'installation'` hands it the relay, as a deployed Control does, and
the relay dispatches its mail to the directory. An older application gets the `x-local-mail`
set itself; it runs the generated production entrypoint, which takes nothing but its
environment, and its boot accepts `directory` only under a loopback `FABRIKA_IAM_ISSUER`
(`@fabrika/app/bun`'s local providers), and refuses it as an unknown provider anywhere else.

`waitForMail` (`src/mail-capture.ts`) reads a mailbox's newest message back for the browser
suites, from IAM or an application; `idempotencyKey` narrows it to one message by the key the
provider got. An older application that holds the set sends under
`transportMailKey({ issuer, appId: '<app>@<env>' }, key)` of `@fabrika/app/testing`; the relay
sends under `relay:<sender>:<key>`, where an application's key already carries that prefix. The
files hold one-time links; they live in
the disposable `.state/` and nothing prints them.

That is the production round trip verbatim, including the handoff, because since
[ADR-0023](../decisions/0023-one-session-per-host.md) there is no other way for a
session to reach an application's host — no cookie is shared between hosts, and
`__Host-` makes the browser enforce it. What makes it work locally is that `local:up`
**registers the local apps with IAM** once the composition is healthy: `vozka` with
`http://control.fabrika.localhost:18080` and `notes` with
`http://notes.fabrika.localhost:18081`, through the same `reconcileSchema` call a
deploy makes. Locally nothing deploys fabrika into its own composition, so the stack
stands in for the deploy — the same way it already provisions the machine key. An app
IAM has no return origin for answers `400` naming the address rather than trying
something else.

Because the console is now a registered app, a **non-admin role is grantable
locally**: the console's roles (`observer`, `triager`, `deployer`, `operator`) and its
action catalog are in IAM from the first `local:up`, so an inline `deploy.read` grant or
a role assignment resolves. There is
no persona switch to fall back on, and adding one back would be a second
authentication model.

The **browser** composition (`browser:up`, `test:browser`) runs the same services
with `LOCAL_DEV_LOGIN` off. Its scenarios seed a real principal, grant and `sessions`
row directly in IAM, plant that login on **IAM's host**, and then drive the real
handoff once per application host to obtain each host's own session. Nothing there is
a shortcut past the proxy, and every request the suite makes still passes the proxy's
decision and is answered with an IAM-minted token. With the bypass off, the suite can also drive an
unauthenticated browser and observe the proxy's `302` to IAM.

`bun run test:browser` uses the configured critical tier. For every browser
scenario, run `OPICE_TIER=extended cpu-lease run -n 4 -- bun run test:browser`.
Entries named `skipped (tier)` did not execute their walkthroughs, even when the
test runner displays them as passing.

## Calling the API from a script

`/api/*` admits either a logged-in human or a `px_` **service key**, so a script
needs one. `local:up` provisions one through IAM's admin surface and writes it to
`packages/local-stack/.state/machine.env` as `FABRIKA_LOCAL_MACHINE_KEY`; the smoke
test uses it. `FABRIKA_IAM_PROVISIONING_KEY` does not work here: IAM resolves it
for its own `/admin/*` surface and it has no credential row, so the proxy refuses
it before control sees the bearer.

```bash
KEY=$(grep FABRIKA_LOCAL_MACHINE_KEY packages/local-stack/.state/machine.env | cut -d= -f2-)
curl -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  --data '{"method":"namespaces.list","input":null}' http://control.fabrika.localhost:18080/api/rpc
```

The generated credentials, the machine key and the proxy manifests live under the
ignored `packages/local-stack/.state/` directory. They remain stable across
`local:down`/`local:up` and rotate on `local:reset`. Do not copy them into
tracked files.

## Runtime boundary

The composition runs these real components:

- IAM, Operations, control and notes Bun servers;
- their real PostgreSQL migrations and data stores;
- SeaweedFS through the production S3-compatible run-log and Operations blob-store
  adapters;
- the Operations Postgres job consumer and scheduled health/notification
  maintenance;
- the proxy authorization service and Caddy in shared network namespaces;
- separate private `platform` and `apps-prod` networks.

The unified console is reached through the proxy and authenticated by IAM; there
is no synthetic persona anywhere in the composition, and no code that could
produce one. Access requests cross the
real control-to-IAM gateway. Operations requests cross the transport-only control
gateway to the private Operations operator API. Machine bootstrap, app API keys,
access-token minting, JWKS verification, schema reconciliation, Operations
catalog/release projection, and managed app environment assembly use the real
services.

Notes can reach the public IAM address through the narrow `iam-public` network
to fetch JWKS, and Control's public address there, where an application's mail
reaches the relay. It cannot resolve or reach the private control, platform
PostgreSQL, SeaweedFS, IAM RPC, or Operations services.

The stateful Zerops emulator implements only the REST calls used by
`@fabrika/provider-zerops`: projects, services, service variables, imports, a
service's autoscaling profile, and app-version lifecycle. A delayed `BUILDING` to
`ACTIVE` transition provides a restart-reconciliation witness. The emulator does
not build code, run containers, bind domains, autoscale (a profile change only
records the new profile id), provide HA, or reproduce Zerops logs.

## Cloudflare Worker proxy witness

The local stack above exercises the Zerops-shaped Caddy boundary. The Cloudflare
thin Worker is exercised separately with Lopata:

```bash
cd packages/iam && bun run oblaka
cd ../../examples/app && bun run oblaka && bun run dev
curl -i http://127.0.0.1:18190/public/hello
curl -i http://127.0.0.1:18190/private
```

The first request reaches the private example app through the proxy and returns
`200 public`. The second stops at the proxy and returns a login redirect. Lopata
must show `APP -> propustka-example-app` and
`IAM -> propustka-worker (PropustkaApplication)`; the app Worker config has no public route and sets `workers_dev: false` and `preview_urls: false`.

That composition predates the application's Durable Object
([ADR-0065](../decisions/0065-an-application-on-cloudflare-runs-in-one-durable-object-per-environment.md)): its app
Worker binds no `FABRIKA_APPLICATION` object and gets no `FABRIKA_PROXY_SECRET`, both of which the current
`createContractWorker` requires, so the curl witness above fails until the example binds them. The application runtime
itself is witnessed in Lopata (0.30 or newer) by `packages/app/src/__tests__/cloudflare-runtime.test.ts`, which runs
the Worker, its object and the R2 bucket in process:

```bash
bun test packages/app/src/__tests__/cloudflare-runtime.test.ts
```
