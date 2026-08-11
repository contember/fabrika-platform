# Sprint — add a GitHub repository, get a deployed app on Zerops (2026-08-11)

**Goal.** An operator adds a GitHub repository — **public or private** — to the control plane, and
fabrika deploys it into the Zerops account. Nothing short of that counts as done.

**The gate.** This sprint has ONE acceptance criterion and every work unit exists to serve it:

> Register an app in the control plane naming a GitHub repository and an environment, trigger a deploy,
> and the application builds from that repository and runs in `fabrika-install-test`. Done **twice** —
> once with the repository public, once with the same repository private. Then a browser signs into it
> through the handoff, and an exception it throws reaches the private operator API.

A work unit that does not move that criterion is out of scope, however tempting.

**Operator prerequisite for the private gate.** The operator creates an organization-owned GitHub App,
installs it on `contember/fabrika-example-zerops`, and configures its identity, private key and webhook
secret once for this Fabrika installation. No Zerops GitHub OAuth grant or per-service GUI connection is
part of the product path. The public source-upload path can be built and proved before those credentials
exist; the private gate needs them.

**Theme.** Everything proven on Zerops so far is the platform _running_. Its predecessors got an
installation up from an empty project and taught `platform deploy` to run unattended from CI. Neither
deployed an **application** — the thing fabrika exists to do. The control plane's Zerops path is fully
written, unit-tested against fakes, and `trigger-deploy` has never built anything on a real account.

The control plane already holds the repository and the GitHub App installation id. What changed during
the run is the transport: Zerops' user-scoped OAuth integration cannot be configured by the installation
token. [ADR-0029](../decisions/0029-an-operator-owned-github-app-delivers-zerops-sources.md) therefore
adds a per-installation `source` service that fetches an exact commit and uploads its archive into the
Zerops build pipeline.

## Refs re-verified at HEAD (2026-08-11)

- ✔ **The control plane already takes a repository, and it is not optional.** `apps` carries
  `repo_url`, `default_branch` (default `'main'`), `worker_dir`, `build_cmd`, `config_path`,
  `github_installation_id` (`migrations/0001_init.sql:33`, row shape `control/src/db.ts:18`); `repoUrl`
  is required on `CreateAppRequest` and `RegisterAppRequest` (`control-contract/src/index.ts:44,201`);
  the console form's second field is "GitHub repo URL" (`dashboard/src/routes/apps/new.tsx`).
- ✔ **A deploy already resolves a concrete ref.** `input.ref ?? concrete trigger_ref ?? refs/heads/<default_branch>`
  (`control/src/api/runs.ts:248-249`), stored on `runs.ref`.
- ✔ **The public checkpoint now consumes the repository.** WU2 derives an ephemeral `buildFromGit`
  from `ProviderDeployInput.app.source` and passes it only on the runtime target
  (`provider-zerops/src/control.ts:263-264,314-319`). It is a proved code seam, not the final source
  transport: WU3 removes it after artifact upload passes the public live gate.
- ✔ **Cloudflare consumes the same input correctly**, which is the shape to copy: `buildJob` resolves
  `input.app.source` and puts `{ repoUrl, ref }` on the runner job
  (`provider-cloudflare/src/control.ts:189,198-199`), and the container clones that ref.
- ✔ **`ZeropsStoredTarget` is one field**, `{ serviceId }`, codec version 2 (`control.ts:25,44`), and it
  is **discovered rather than supplied** — `prepareRegistration` imports the manifest's services and
  finds `deployService` by hostname (`control.ts:351-386`), which is why the console posts an empty
  target placeholder. Any new persisted field means a codec version bump, not a migration.
- ⚠ **Registration still requires a locally built manifest, pasted as text.** `fabrika app build` writes
  `fabrika.manifest.json` to disk and makes no network call (`provider-zerops/src/cli.ts:72-74`); it
  reaches control only as the `artifact` field, stored inline in `app_envs.provider_artifact_json`
  (`control/src/registry.ts:216`), and the console offers a `<textarea>` for it
  (`dashboard/src/routes/apps/new.tsx:169-183`). There is no artifact upload endpoint. See the open
  decision below — this is the one part of the gate that is not obviously satisfied.
- ⚠ **The private path forces the descriptor to the repository root.** Read live off the API:
  `SetupExternalRepositoryIntegration` takes
  `{repositoryFullName, branchName, eventType, isActive, triggerBuild, tagRegex, zeropsYamlSetup}` — a
  setup NAME and no descriptor — and `TriggerExternalRepositoryIntegration` takes only
  `{userData, userDataEnvFile}`. There is **no `zeropsYaml` and no path field on either.** So an app
  whose `zerops.yaml` is not at its repository root cannot be deployed privately, at all.
- ✔ **Inline `zeropsYaml` works, but only on the public trigger.** Proven live: a setup named
  `wu1inline`, which exists nowhere in `contember/fabrika-platform`, built from that repository and
  reached `ACTIVE` (14:50:37 → 14:51:37). Useful to know, and deliberately **not** the foundation — see
  decision 2.
- ⚠ **Zerops OAuth is user-scoped, not available to the installation token.** The GUI grant lists the
  example repository, but `SetupExternalRepositoryIntegration` on a disposable service, called with
  the exact token installed on `control`, returned `400 githubAuthorizationRequired`. A follow-up read
  returned `noExternalRepositoryIntegration`; the disposable service was deleted. The native
  integration cannot be Fabrika's unattended private-source mechanism.
- ⚠ **A Zerops run's build log never reaches the run record.** Relayed faithfully by the provider
  (`provider.ts:92-114`), then wired to a `console.info` line and nothing else
  (`run-lifecycle.ts:314`); the run's `log_key` object is written only by the Cloudflare runner relay
  (`runner-cloudflare/src/relay.ts:114`). Every Zerops run answers `GET /runs/:id/log` with an empty
  list. → [`69`](../backlog/69-a-zerops-runs-log-never-reaches-the-run-record.md).

## Work units

### WU1 — An app on Zerops is a repository root (effort S) · decide this first

- **Problem.** Both deploy paths require `zerops.yaml` at the root of the repository being built, and the
  private path offers no alternative at all (refs above). The example app keeps its descriptor in
  `examples/zerops-app/`, inside this monorepo, and its own header admits it is pretending
  ("it lives here because this example IS that repo … for convenience"). Nothing can deploy it.
- **Scope.** Write the ADR — an application fabrika deploys to Zerops is a Git repository whose root
  carries `zerops.yaml`, and fabrika does not paper over that with an inline descriptor. Move
  `examples/zerops-app/` to its own repository with the descriptor at the root. Keep it reachable from
  this repository's typecheck and tests, or state plainly what coverage is lost.
- **Acceptance / witness.** The ADR exists and the example repository builds on Zerops from its own
  root. **One repository serves both halves of the gate**: create it public, and flip it to private for
  the second half — same code, same descriptor, only visibility changes, which is the cleanest possible
  A/B for WU2 and WU3.
- **Touch points.** `docs/decisions/`, `examples/zerops-app/`, a new public repository,
  `packages/installation-zerops/zerops/__tests__/example-app.test.ts`.

### WU2 — Public `buildFromGit` proves the source seam (effort M) · completed checkpoint

- **Problem.** `apps.repo_url` and the resolved `runs.ref` reach the provider and are dropped
  (refs above). This is the whole public half of the gate.
- **Scope.** Thread `input.app.source` into the Zerops deploy the way Cloudflare already does: derive
  the build source from `repoUrl` + `ref`, put it on `ZeropsRuntimeTarget`, and pass it at
  `trigger-deploy`. The codec bump belongs to the RUNTIME target, which is composed per run and
  persists nothing — prefer that over widening `ZeropsStoredTarget`, which would need a version 3 and a
  backfill for no gain.
- **Scope guard.** A **public** URL carries no credential. A credentialed clone URL stays refused by
  [ADR-0029](../decisions/0029-an-operator-owned-github-app-delivers-zerops-sources.md) — the platform
  records what it is given. WU3 replaces this checkpoint with the one transport used by public and
  private application repositories.
- **Acceptance / witness.** A deploy triggered from the console against the **public** example
  repository builds and reaches `ACTIVE` in `fabrika-install-test`, and the app answers on its own host.
- **Touch points.** `packages/provider-zerops/src/{control,provider,types}.ts`.

### WU3 — An operator-owned GitHub App delivers source archives (effort L)

- **Problem.** [`47`](../backlog/47-give-the-zerops-path-a-private-git-source.md). The native Zerops
  integration requires a user identity even after the account OAuth grant exists. The control plane's
  project-scoped integration token cannot configure it, so it cannot be the unattended product path.
- **Verify first — passed live.** The supported `zops push` sequence ran against disposable service
  `wu3uploadprobe` using the installation token: it created an app version, streamed the public
  repository-root archive and called `build-and-deploy` with setup `notesapi`. Zerops downloaded
  24.9 KiB, completed every build command and produced a 47.3 MiB deploy artifact. Runtime deploy then
  failed as expected because the probe had no application database or environment. The service was
  deleted. This is sufficient to start the GitHub/source-service half.
- **Upload destination — measured live.** A second disposable app version returned HTTPS host
  `proxy.app-prg1.zerops.io`, exact path `/api/rest/object-storage/upload`, no port or fragment, and a
  signed query. Only this origin and path are accepted for the `prg1` installation; redirects are
  refused. The probe service was deleted.
- **Crash state — measured live.** Zerops kept an app version at `UPLOADING` after a successful archive
  PUT, so platform status cannot distinguish partial from complete source upload. `deleteAppVersion`
  returned success and removed both an unuploaded version and a successfully uploaded, untriggered
  version. The disposable `wu3stateprobe` service was deleted.
- **Scope.** Implement ADR-0029:
  - provision one non-public `source` service alongside `control` in the Zerops installation;
  - split webhook verification from GitHub App token minting so Zerops `control` keeps only the webhook
    secret and delegates installation lookup, ref resolution and source transport to authenticated
    source RPC;
  - embed the bounded root `zerops.yaml` and its digest in the registration artifact, resolve the exact
    source commit before Operations release projection, and refuse descriptor drift;
  - have `control` create and durably record the app version, pass only its presigned upload URL and the
    exact commit to `source`, and retain the Zerops integration token and later `build-and-deploy` call;
  - persist the provider checkpoint
    `version_created → source_uploaded → build_trigger_requested → build_triggered`; conservatively
    delete and fail a pre-trigger version after an ambiguous crash instead of repeating an upload or
    trigger whose response was lost;
  - resolve the requested ref to an exact commit, inspect and archive Git objects without a checkout,
    and stream the repository-root archive to that upload URL;
  - keep the GitHub App private key only as a `source` service secret, and return only the resolved
    commit, descriptor digest, upload outcome and redacted events to `control`;
  - use the upload path for public and private repositories, then remove WU2's application
    `buildFromGit` path.
- **Security gates.** Project-network reachability is not authorization. Tests must prove an unsigned
  source request is refused; the request binds repository, ref, installation, app version, upload URL
  and run; only the live-verified Zerops HTTPS upload origin, path, empty userinfo and non-empty signed
  query are accepted; redirects and an
  attacker destination receive zero bytes; no repository content is returned; symlinks, submodules,
  special entries, escaping paths and trees above hard count or byte limits are rejected without
  reading local files; an upstream error cannot disclose a clone URL,
  token or presigned upload URL; the Zerops token never enters `source`; cancellation cleans temporary
  data and the orphaned app version; and app code is never executed by `source`.
- **Acceptance / witness.** Through the control-plane API, the same exact example commit builds and
  reaches `ACTIVE` once while the repository is public and once after it becomes private. Both runs use
  the artifact-upload path, name the same resolved commit, and expose no GitHub credential in Fabrika
  logs, Zerops process data or application-version metadata.
- **Touch points.** New `packages/source-zerops/`; `packages/control/src/repo-source.ts` and composition;
  `packages/provider-zerops/src/{api,control,provider,types}.ts`; `packages/installation-zerops/` and its
  generated topology; the run repository and migrations for provider checkpoints; run-log, recovery
  and release correlation tests.

### WU4 — A failed build fails the deploy (effort S) · protects every other unit

- **Problem.** [`70`](../backlog/70-a-failed-zerops-build-hangs-await-deploy-for-seventy-minutes.md),
  found while scoping this sprint. A `stack.build` that fails before it creates a container leaves its
  app version at `WAITING_TO_BUILD` permanently, and `await-deploy` polls only the version, with a
  70-minute timeout.
- **Why it is in this sprint rather than the backlog.** Source delivery attempts fail in exactly this
  state for a wrong setup, invalid archive or inaccessible repository, and each would otherwise cost
  seventy minutes and report nothing.
- **Acceptance / witness.** A deploy whose build cannot start fails in seconds naming the failed
  process, and a suite test drives the fake through the live state pair (`process FAILED` +
  `version WAITING_TO_BUILD`).
- **Touch points.** `packages/provider-zerops/src/{provider,api}.ts`.

### WU5 — The gate's last mile: signed in, and reporting its own errors (effort M)

- **Problem.** [`05`](../backlog/05-bring-up-on-a-real-zerops-account.md) items 3 and 4 have never been
  observed. The code that should make them true exists — return origins are projected by
  `reconcile-schema` (`provider.ts:233,242-249`) and the Operations keys are written as service-scoped
  env vars before the plan runs (`control.ts:234-262`) — which is precisely the condition under which
  the last three sprints each found a defect.
- **Scope.** Observe, then fix what the observation breaks. No planned code.
- **Acceptance / witness**, and these are the gate's closing clauses:
  1. A browser signs into the deployed app through the handoff — its return origin registered by the
     deploy, not by hand.
  2. `FABRIKA_OPERATIONS_DSN` and `FABRIKA_RELEASE` are present on the running service, read back from
     the account.
  3. An exception the app throws reaches the private operator API and appears in the Operations console,
     correlated to the release the deploy recorded.
- **Touch points.** Unknown by construction.

### WU6 — A Zerops deploy's log is readable (effort S)

- **Problem.** [`69`](../backlog/69-a-zerops-runs-log-never-reaches-the-run-record.md), refs above.
- **Why it is in this sprint.** Six live deploys are about to be debugged, and on this provider the
  console shows nothing. It pays for itself during WU2 alone.
- **Scope.** Write the relayed lines to the run's `log_key` object from the control plane, so the writer
  is the plane that owns the run rather than a provider-specific runner. Keep the stdout line.
- **Acceptance / witness.** `GET /runs/:id/log` for a WU2 deploy returns its Zerops build log, and the
  console renders it. Against a live run, not a fixture.
- **Touch points.** `packages/control/src/run-lifecycle.ts`, `packages/control/src/api/runs.ts`.

## Out of scope (explicit)

- **[`60`](../backlog/60-the-example-app-has-no-light-tier-descriptor.md), the shared-database
  descriptor.** It is a `fabrika-test` problem: `notesapi` there was created by hand against the shared
  `db`. On a fresh installation the example's own import creates `notesdb`, which is exactly what its
  committed `zerops.yaml` interpolates. Confirm that on the target and leave the item alone.
- **The production two-project shape and custom domains** — [`05`](../backlog/05-bring-up-on-a-real-zerops-account.md)
  items 1 and 2. One installation, light tier.
- **`fabrika app deploy` as a Zerops CLI verb.** The CLI accepts only `build` for the Zerops app area
  (`cli/src/index.ts:145-150`) and the control plane is the entry point by design.
- **A live Cloudflare bring-up.** The mechanism has precedent in the predecessor project (vozka); what
  this repository has never done is exercise it. Its own sprint.
- **[`67`](../backlog/67-command-for-the-first-administrator.md) and
  [`68`](../backlog/68-platform-commands-mishandle-a-closed-stdin.md).** `fabrika-install-test` already
  has an administrator.

## Decisions

1. **One acceptance criterion, stated as a gate.** Both halves — public and private — or the sprint is
   not done. This replaces the earlier plan's "public now, integration later", which would have shipped
   a mechanism that cannot serve a private repository and called it progress.
2. **An app on Zerops is a repository root, and fabrika does not hide that.** Forced by measurement, not
   preference: the integration API can name a setup and nothing else. An inline descriptor works on the
   public trigger and would therefore let a monorepo app deploy publicly and break on the day it went
   private — a trap worth naming, because the earlier plan recommended exactly it.
3. **One application-source transport.** Public and private repositories both become an uploaded app
   version. Public fetches need no GitHub credential; private fetches mint a GitHub App installation
   token. WU2's application `buildFromGit` path is deleted after WU3 proves parity.
4. **The source helper is not a deploy runner.** It resolves, fetches, packages and uploads one exact
   commit from Git objects, but never checks it out or executes repository code. The provider artifact
   carries the bounded root descriptor required by Zerops; source returns only its digest. Zerops still
   performs the build and deploy. The helper
   runs as a non-public `source` service beside `control`, with authenticated RPC because application
   services can share the project network.
5. **Target `fabrika-install-test`.** Created by `platform install`, untouched by hand, so an
   observation from it means what it says.
6. **The GitHub machine identity is operator-owned.** Each installation uses an organization-owned
   GitHub App installed on selected repositories. Fabrika does not operate a central App or hold a
   credential shared across operators. → [ADR-0029](../decisions/0029-an-operator-owned-github-app-delivers-zerops-sources.md).

## Open decision — the gate says "add a repository", registration also wants a manifest

Today an operator registers an app by pasting a locally built `fabrika.manifest.json` into a textarea.
So what the gate literally asks for — add a repository, get a deploy — is today "add a repository AND
paste a compiled artifact". Three ways out, and this needs an answer before WU2 is called done:

- **Accept it for this sprint** and say so in the outcome. The gate's substance is that the deployed
  CODE comes from the repository, which WU2 and WU3 deliver; the artifact is registration ergonomics.
- **The CLI pushes the manifest** to a new endpoint, so the operator runs one command instead of copying
  a file. Small, and does not change who evaluates the app's config.
- **The control plane builds the manifest itself** from the repository. This is the honest reading of
  the gate and the largest of the three by far — it means the control plane clones an app repository and
  **evaluates its TypeScript config**, which is running the app author's code inside the plane that
  holds every credential. That is a security decision needing its own ADR, not a work unit.

Recommendation: the first for this sprint, the second as a follow-up item, and the third only behind an
ADR that faces the sandboxing question directly.

## Sequencing

|                                     | depends on                       | can run alongside        |
| ----------------------------------- | -------------------------------- | ------------------------ |
| WU1 (repository-root ADR + example) | —                                | WU4, WU6                 |
| WU4 (fail a failed build fast)      | —                                | WU1, WU6                 |
| WU6 (run log into the run record)   | —                                | WU1, WU4                 |
| WU2 (public source seam checkpoint) | WU1                              | WU3 upload measurement   |
| WU3 (GitHub App + source service)   | WU1, upload measurement          | WU2 live public baseline |
| WU5 (sign-in + Operations ingest)   | WU3 live public + private deploy | —                        |

WU4 and WU6 landed first because they make the later live attempts debuggable rather than seventy
minutes of silence each. WU3 begins with the smallest disposable upload probe. Its source-service code
starts only after the installation token proves it can complete the three app-version operations. The
GitHub App is required only for WU3's private acceptance, not for that upload proof.

## Run log

### Scoping probes (2026-08-11)

Run against `fabrika-install-test` (`AI6fLiNmTQGJQvlhbUtBaw`) on throwaway services `wu1probe` and
`wu1inline`, both deleted afterwards. Neither needed the example app or a database — every question here
is a platform behaviour.

**A build source is a property of an app VERSION, never of the service.** On one service, in this order:

| call                                                             | result                                             |
| ---------------------------------------------------------------- | -------------------------------------------------- |
| import declaring `buildFromGit`                                  | created the service AND started a build by itself  |
| `PUT trigger-pipeline` body `{}`                                 | refused — `Service stack not found`                |
| `PUT trigger-pipeline` body `{"zeropsSetup":"iam"}`              | refused — `Invalid parameter provided`             |
| `PUT trigger-pipeline` body `{"buildFromGit":…,"zeropsSetup":…}` | accepted — the version BUILT, then `DEPLOY_FAILED` |
| `PUT trigger-pipeline` body `{}`, **after that build**           | refused again — `Service stack not found`          |
| `PUT trigger-pipeline` body `{"zeropsSetup":"iam"}`, after it    | refused again — `Invalid parameter provided`       |

The last two rows make it conclusive rather than suggestive: the service had by then built and deployed
a version **from that very source**, and a bare trigger was still refused with the identical errors. The
`DEPLOY_FAILED` is not a finding — the probe built IAM's setup into a service with none of IAM's
environment; `BUILDING → DEPLOYING` is the part that answers the question. Recorded in
[`reference/zerops-platform.md`](../reference/zerops-platform.md).

The two refusals disagree with each other about the same missing input and neither mentions a build
source. Worth knowing before someone debugs a real one.

**An app can already declare `buildFromGit`, and it was the wrong place to put it.**
`ZeropsServiceSpec = Omit<ZeropsImportService, ZeropsCompilerOwnedServiceField>` does not subtract the
field (`types.ts:69-80`), and compiling the example with one added emits it into the import document
verbatim. The scoping conclusion was therefore "author it in `fabrika.config.ts`" — **wrong**, and the
control-plane survey is what corrected it: `apps.repo_url` is already required and already reaches the
provider. An app config field would have been a second place to say the same thing.

**Inline `zeropsYaml` works on the public trigger.** Setup `wu1inline`, absent from
`contember/fabrika-platform`, built from that repository and reached `ACTIVE` (14:50:37 → 14:51:37). No
subdirectory or path field exists anywhere — not in the import service schema, not in the trigger body —
so this was the only candidate for deploying an app whose descriptor is not at its repository root.

**And then the integration schema killed it as a foundation.** `SetupExternalRepositoryIntegration`
takes `{repositoryFullName, branchName, eventType, isActive, triggerBuild, tagRegex, zeropsYamlSetup}`
and `TriggerExternalRepositoryIntegration` takes `{userData, userDataEnvFile}` — no descriptor on
either, only a setup name. So the private path cannot carry an inline descriptor, and building the
public path on one would have produced apps that deploy until they go private. → decision 2, WU1.

**Finding — a failed `stack.build` leaves the app version at `WAITING_TO_BUILD` forever.** The import's
build process was `FAILED` 500 ms after starting (12:33:41.202 → 12:33:41.702), with no build container
and no message on the process object; its version had not moved eight minutes later. →
[`70`](../backlog/70-a-failed-zerops-build-hangs-await-deploy-for-seventy-minutes.md), promoted into
this sprint as WU4.

### WU1 checkpoint (2026-08-11)

The example is now a self-contained repository-root tree while remaining under
`examples/zerops-app/` for workspace typecheck and test coverage. ADR-0028 records the repository-root
invariant. The public mirror is `contember/fabrika-example-zerops`.

An isolated export passed `bun install --frozen-lockfile`, typecheck and all 17 example tests against
the published `@fabrika/*` 0.0.4 packages. The workspace's example, topology and Zerops YAML suites
passed 152 tests.

Live in `fabrika-install-test`, disposable service `wu1root` built from
`https://github.com/contember/fabrika-example-zerops@main` with explicit setup `notesapi`. Zerops read
the repository-root descriptor, completed every build command, and uploaded a 47.3 MiB deploy artifact.
The later deploy failed as expected because this build-only probe had neither the app database nor its
runtime environment. The disposable service was deleted afterwards.

### GitHub authorization boundary (2026-08-11)

The operator completed the Zerops GitHub OAuth flow, and the GUI repository picker listed
`contember/fabrika-example-zerops`. The earlier inference that authorization had not completed was
wrong: `getGithubRepositories` was being called with an identity that cannot consume a user's grant.

The decisive probe used the exact project-scoped integration token stored on `control`, not a local
personal token. On disposable service `wu3oauthprobe`, `SetupExternalRepositoryIntegration` returned
`400 githubAuthorizationRequired`; the status endpoint then returned
`noExternalRepositoryIntegration`. The service was deleted. This proves the native integration cannot
be configured by the installation identity even when the GUI OAuth grant exists. → ADR-0029.

### WU2, WU4 and WU6 code checkpoint (2026-08-11)

WU4 now watches the pipeline process as well as the app version. A terminal process failure takes
precedence over an apparently active version and names both ids and both observed statuses. The focused
provider and installation suites passed 36 tests; independent review found and closed the
`process=FAILED` + `version=ACTIVE` ordering edge. Commit: `ebb4d3c`.

WU6 now serializes provider event lines as `RunLogLine` NDJSON into the run's existing `log_key` object
and flushes the queue before either success or failure becomes terminal. A provider that emits no
control-side lines performs no object write, so a Cloudflare runner-owned log is not overwritten. The
focused control suites passed 38 tests; the success-path test holds two writes open in turn and proves
both serialization and the terminal-transition barrier through the existing run-log reader. Commit:
`96a782b`.

WU2 now derives an ephemeral public `buildFromGit` value from the registered repository and resolved
run ref. It normalizes full head and tag refs, refuses credential-bearing or malformed repository URLs
before any platform mutation, and does not widen the stored target. The focused provider suites passed
33 tests after independent review found and closed malformed URI-scheme rewriting. Commit: `8e95c1c`.

All three units passed their package typechecks, dprint checks and scoped diff checks. Main-branch CI
run `31508206043` then passed quality, the complete PostgreSQL/S3 suite, deployable builds and release
artifact verification. These are code and integration-test witnesses only: WU2's `ACTIVE` application,
WU4's live fast failure and WU6's live API/console log remain open until a release reaches the
installation.

No release was cut at this checkpoint. The later direct integration probe established that the
installation token cannot consume the GUI user's OAuth grant, so releasing WU2 alone would still leave
the private half of the gate impossible.

### WU3 architecture checkpoint (2026-08-11)

The native repository-integration plan is retired by the authorization-boundary probe above. The
replacement is [ADR-0029](../decisions/0029-an-operator-owned-github-app-delivers-zerops-sources.md):
an operator-owned GitHub App supplies machine identity, and a non-public per-installation `source`
service transports an exact repository snapshot through Zerops' app-version upload pipeline. Zerops
still executes the application build and deploy.

The upload prerequisite then passed live on disposable service `wu3uploadprobe`. The existing
installation token created app version `vjY1dFq2Q2uXWASEjGizWg`, uploaded 24.9 KiB of source and started
process `zyEbPBfKSpSKSvCNy6nZOw`. Zerops completed `bun install --frozen-lockfile`, built the application
and uploaded a 47.3 MiB deploy artifact. The runtime deploy failed because the deliberately empty probe
had neither the app database nor runtime environment. The service was deleted. WU3 can now implement
the service, authenticated RPC, GitHub App setup, private-source fetch and removal of WU2's temporary
application `buildFromGit` path.
