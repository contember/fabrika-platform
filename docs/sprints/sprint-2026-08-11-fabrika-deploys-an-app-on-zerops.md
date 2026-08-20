# Sprint — add a GitHub repository, get a deployed app on Zerops (2026-08-11)

**Goal.** An operator adds a GitHub repository — **public or private** — to the control plane, and
fabrika deploys it into the Zerops account. Nothing short of that counts as done.

**The gate.** This sprint has ONE acceptance criterion and every work unit exists to serve it:

> Register an app in the control plane naming a GitHub repository and an environment, trigger a deploy,
> and the application builds from that repository and runs in `fabrika-install-test`. Done **twice** —
> once with the repository public, once with the same repository private. Then a browser signs into it
> through the handoff, and an exception it throws reaches the private operator API.

A work unit that does not move that criterion is out of scope, however tempting.

**Operator prerequisite for the private gate.** An authenticated administrator opens **Settings →
Source** in Control, creates or adopts the organization-owned GitHub App and approves its installation
on `contember/fabrika-example-zerops` in GitHub's UI. `platform init` repairs the source transport but
is not a second normal App-creation path. No Zerops GitHub OAuth grant or per-service GUI connection is
part of the product path. The public source-upload path works anonymously; the private gate needs the
installed App.

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
- ✔ **The application deploy now uses one source-upload path.** WU2's ephemeral application
  `buildFromGit` checkpoint has been removed. The provider resolves the exact commit and registered
  descriptor digest before creating the Operations release, then creates an app version, uploads the
  bound archive and calls `build-and-deploy`. Public and private repositories share this lifecycle.
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
  list. → `backlog/69` (since shipped and deleted).

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

### WU3 — An operator-owned GitHub App delivers source archives (effort L) · code complete; live gate open

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
  - use the upload path for public and private repositories and remove WU2's application
    `buildFromGit` path; both are implemented, with live parity still to prove.
- **Code witness.** Commits `d091d67`, `49f3b17`, `4084234`, `4ab9ec2`, `5bc1f0e`, `68854f3` and
  `71e406a` implement this scope; `b55d059` makes archive order independent of GitHub metadata order
  and `5c9d99f` migrates active legacy Zerops runs into the exact recoverable checkpoint. Commit
  `627c5d9` implements the shared manifest flow, `419dffb` adopts it on Cloudflare without the
  `onCreated` durability hook, and `0592334` adds the optional awaited bounded hook. Commits `3e4c2b6`,
  `1e6f4b1` and `6a36a2d` implement App-JWT verification and create-only service variables; `e74bd1c`
  is the historical seamless CLI implementation described by ADR-0030. Commits `a64278f`, `d6dd195`,
  `459bc64` and `ecd49b9` add legacy credential adoption, narrow init to anonymous bootstrap/repair,
  implement the authenticated Control workflow from ADR-0031 and expose it in the dashboard. The
  source service, provider lifecycle, control delegation, installation topology and supported upgrade
  flow are locally verified. The complete live browser setup and both live deploys remain open.
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

- **Problem.** `backlog/69` (since shipped and deleted), refs above.
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
   token. WU2's application `buildFromGit` path is deleted; public/private live parity remains the
   acceptance witness, not a second production branch.
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
had neither the app database nor runtime environment. The service was deleted. This probe established
the upload API prerequisite; the implementation checkpoint below supersedes the earlier pending-work
conclusion.

### WU3 implementation checkpoint (2026-08-12)

Commit `d091d67` added the public source RPC contract, descriptor-bearing provider artifact, bounded
control HTTP client and persisted provider run state. Commit `49f3b17` isolated GitHub App JWT,
installation lookup and short-lived token minting in the credential-owning package. Commit `4084234`
then implemented the provider's resolve → app-version create → upload → build-and-deploy lifecycle,
including durable checkpoints and conservative cleanup after ambiguous pre-trigger failures.

Commit `5c9d99f` maps only active legacy Zerops runs with an external app-version id and no provider
checkpoint to `build_triggered`, matching the historical order in which that id was persisted. One
malformed or failing reconciliation row no longer prevents later rows from progressing, and failures
after a terminal database transition cannot reclassify that run as active.

Commits `4ab9ec2` and `5bc1f0e` moved Zerops repository installation lookup, commit resolution and
archive upload behind the authenticated source RPC while keeping strict webhook HMAC verification on
control. The provider binds the descriptor digest before Operations projection. The temporary
application `buildFromGit` path is gone.

Commit `71e406a` added the private source runtime. Production accepts only `github.com` repositories and
uses `api.github.com`; there is no GitHub Enterprise or API-base configuration knob. GitHub App id and
private key are optional together, so anonymous public fetch remains available without App
configuration. Before any Git fetch, the runtime resolves commit metadata and the recursive tree over
GitHub REST. GitHub documents a maximum of 100,000 entries or 7 MB for its
[recursive tree response](https://docs.github.com/en/rest/git/trees#get-a-tree). Fabrika admits at most
50,000 entries and 512 MiB of declared expanded bytes, bounds the REST response to 8 MiB, refuses a
truncated tree and rechecks fetched Git objects against the approved metadata. It archives objects
without a checkout and rejects symlinks, submodules, special entries and unsafe paths.
Commit `b55d059` made file and parent-directory ordering explicit UTF-8 byte order, so the same Git tree
produces the same archive even when GitHub returns metadata entries in a different order.

The control-side RPC deadlines are 45 seconds for installation lookup, five minutes for resolve,
20 minutes for upload and 30 seconds for cancellation. Source expires installation lookup after
30 seconds, resolve after four minutes and upload after 15 minutes, with a ten-minute upload PUT cap.
This leaves time to return the stable redacted error envelope before control's outer deadline.

Commit `68854f3` added private `source` to both Zerops topologies and the generated artifacts. It runs
on port 3000, installs `git`, has no public route or Zerops token, and is deployed in the enforced order
`iam → operations → source → proxy → control`. Fresh `platform install` generates one shared RPC key;
the source-side spelling is `FABRIKA_SOURCE_RPC_KEY` and the control-side spelling is
`FABRIKA_ZEROPS_SOURCE_RPC_KEY`. A fresh install may receive an optional all-or-none App pair for source
and an independently optional webhook secret for control. Otherwise source starts in anonymous mode
and interactive init configures the App later.

Commit `627c5d9` added the shared manifest helper. Commit `419dffb` adopted that helper on Cloudflare
without an `onCreated` durability hook. Commit `0592334` added the optional, awaited and bounded
`onCreated` callback. Zerops supplies it in commit `e74bd1c`: init writes GitHub's one-time conversion
response to an absolute XDG state path outside the worktree before the helper reports success. The
bounded recovery file has an exact installation, project and live-control-origin binding, owner-only
directory and file modes, an atomic fsync-backed publish and strict stale-file cleanup.

Commits `3e4c2b6` and `1e6f4b1` added strict App-JWT verification of the App identity, owner,
visibility, exact read-only authority, `push` event, webhook structure and organization/repository
installation. Commit `6a36a2d` added the create-only Zerops service-variable seam. Commit `e74bd1c`
composed these pieces into `platform init`:

- anonymous mode is offered only for empty live state with no recovery and no requested repository;
- create, resume, existing and preserve modes require strict, mutually compatible live and recovery
  state; partial or mismatched state is refused;
- App-backed modes bind the manifest and webhook to the exact live HTTPS control origin, default a
  same-organization App to private and require an explicit public choice across organizations;
- missing RPC and GitHub values use create-only writes, with bounded exact rereads after duplicate or
  ambiguous results and final stability reads for both RPC keys and all three GitHub fields;
- recovery is deleted after durable Zerops credentials plus App identity and webhook structural
  verification, before the App installation UI opens; every App-backed init run then verifies the
  organization or each requested repository through App-JWT endpoints.

The helper cannot close the instant after GitHub irreversibly accepts manifest conversion but before
`onCreated` begins or can persist. Such an App must be deleted and recreated. GitHub masks the webhook
secret, so readback verifies only the URL, JSON content type and TLS setting after the patch. A
loopback TCP lock keyed by Zerops project and installation serializes init on one host independently of
the XDG recovery root. It is not distributed: create-only conflicts and final rereads fail closed on
observed interference, but cannot stop another host writing after final verification. One operator per
project at a time is the supported operational boundary. Source credentials never enter the sidecar
checkout, repository or GitHub Environment.

Local witnesses for the landed code:

- the source package suite: `bun test packages/source-zerops` — 68 passed, 0 failed, 153 expectations
  across four files;
- the focused control verification for the delegation and lifecycle: 116 tests across 11 suites, plus
  the control and provider package typechecks;
- the final installation package suite: 335 passed, 0 failed, 2,918 expectations; the focused seamless
  init verification: 46 passed, 0 failed, 190 expectations; plus package typecheck and `gen:check`;
- dprint, Biome, scoped diff checks and the repository no-type-hacks scan passed for each landed unit.

No release, complete live GitHub/Zerops init or end-to-end live application deploy was performed at
this checkpoint. WU3 therefore still needs the same exact commit to reach `ACTIVE` through app-version
upload first as a public repository and then as a private repository in `fabrika-install-test`, with
credential absence checked in logs and Zerops metadata. WU5's browser handoff, managed Operations
environment and correlated exception ingest also remain live-only gates. The sprint and backlog item
47 stay open until those witnesses exist.

### WU3 Control-managed source checkpoint (2026-08-14)

The normal setup authority has moved from laptop-side init into authenticated Control, as accepted by
[ADR-0031](../decisions/0031-manage-zerops-github-source-from-control.md):

- commit `a64278f` added deterministic adoption of a complete legacy or canonical source credential
  set. It creates the atomic bundle only when needed, activates the exact digest and returns no
  credential to Control;
- commit `d6dd195` removed App creation and XDG recovery from current Zerops init. Fresh installations
  stay anonymous. Upgrades preserve complete remote credentials for Control adoption and refuse
  partial or conflicting state, while init repairs the source RPC transport and creates the nonsecret
  Control project binding;
- commit `459bc64` added the human-gated Control workflow, encrypted manifest and recovery state,
  compare-and-set phase leases, create-only source persistence, in-process activation, dynamic
  vault-backed webhook verification, exact App/installation verification and repair; and
- commit `ecd49b9` added **Settings → Source**, covering anonymous creation, legacy adoption, resumable
  manifest handoff, installation verification, repair, connected and unavailable states. Its polling
  runs only while setup is pending, and its continuation link accepts only the exact same-origin path
  bound to the persisted connection id.

The callback is still subject to GitHub's unavoidable acceptance-to-persistence orphan window, but a
durable recovery or adoption checkpoint now resumes after a bounded phase lease instead of remaining
pending forever. The browser never receives the App private key, webhook secret, source RPC key,
GitHub token or manifest code. Opaque callback state passes only through the bounded handoff form and
never enters a browser DTO, log, error or persisted plaintext. App creation and installation remain
live-only witnesses; no release or live GitHub/Zerops flow was performed at this checkpoint.

Local witnesses at this checkpoint:

- provider adoption: 12 focused tests passed with 59 expectations;
- Control workflow, persistence and secure callback handling: 42 focused tests passed with 181
  expectations;
- Zerops init/repair: 16 focused tests passed with 88 expectations;
- dashboard DTO, RPC and lifecycle presentation: 15 focused tests passed with 47 expectations, and
  the package typecheck and production build passed under a CPU lease; and
- the four focused commands reported zero failures. Documentation formatting and link checks belong
  to this checkpoint's documentation change.

The workflow emits the same best-effort domain audit calls as existing Control mutations. Making audit
delivery durable is repository-wide follow-up [`71`](../backlog/71-deliver-domain-audit-events-durably.md),
not a private WU3 blocker.

### The public half of the gate is met (2026-08-19)

`notes/prod` builds from `contember/fabrika-example-zerops` and serves through the namespace proxy:

```
GET https://proxy-2b16-8080.prg1.zerops.app/healthz   → 200 {"status":"ok"}
GET https://proxy-2b16-8080.prg1.zerops.app/api/notes → 302 https://proxy-2ec8-8080.prg1.zerops.app/auth/login
                                                             ?app=notes&redirect=…&state=…&code_challenge=…
```

The public path answers, the gated path is refused BY THE PROXY and handed to IAM with PKCE, and the
application enforces nothing ([ADR-0022](../decisions/0022-the-proxy-is-the-only-enforcement-point.md)).
Run `01a0199b-d112-7004-9482-da5ebcbb8423` succeeded through `reconcile-schema`; app version 5 is
`ACTIVE`.

It runs in `fabrika-notes-prod`, not `fabrika-install-test` as the gate's wording says. That wording
predates deployment namespaces: an app now gets its own project with its own proxy, and the `mid`
preset is what this app asked for. The criterion the wording was protecting — fabrika deploys a
GitHub repository into the account and it serves — is met.

**Five defects stood between the registration and the first request, none of them reachable before
now.** Each was measured, not inferred:

| What                                                                                                              | Where it is fixed                                                                                   |
| ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| The installation's integration token structurally could not create a project                                      | [ADR-0034](../decisions/0034-the-control-plane-creates-the-projects-it-owns.md), `platform install` |
| `sensitive` became required on every user-data write, so a namespace's first proxy variable failed                | `provider-zerops/src/api.ts`                                                                        |
| `400 userDataSyncRunning` — the deploy wrote five variables and asked for a build while they synced               | `provider-zerops/src/api.ts`, which now waits out each write's process                              |
| `postgresql:ha@18` offers TLS on `portTls` only, so the canonical DSN could not connect                           | every writer of a fabrika PostgreSQL URL, including the `standard` tier's own                       |
| `apps.environments.put` normalised the caller's envelope, so a namespaced provider refused every changed manifest | `control/src/api/registry.ts`, sharing one `prepareRegistration`                                    |

Two diagnosis defects came out of the same hunt, and both cost hours before they were found:
`build-and-deploy` discarded its error CODE, so `userDataSyncRunning` read as a bare `(400)`; and
`cleanupPreTriggerVersion` threw over the failure it was cleaning up after, so one real refusal
surfaced as `delete app-version failed (400)` with the cause gone. Both are fixed.

**WU6 is met.** `control runs log` returns a Zerops run's build log, including the container's own
stack trace, against a live run, so `backlog/69` is consumed and deleted. One rough edge: `RunLogWriter` rewrites the whole object per line, so a
concurrent read occasionally sees nothing.

**WU5 partially witnessed.** `FABRIKA_OPERATIONS_DSN` and `FABRIKA_RELEASE`
(`fabrika/notes/prod/default/1919eb31…`, the mirrored source commit) read back from the live service.
The browser sign-in and the exception reaching Operations are still open.

**Still open, and it needs the operator.** The private half needs **Settings → Source** for the second
organization and the repository flipped to private.

`FABRIKA_IAM_ISSUER` had to be written straight through the Zerops env API here, because an app
variable set in the control plane reached no Zerops service. That was a decision rather than a bug and
it is settled: [ADR-0035](../decisions/0035-the-platform-owns-the-application-iam-issuer.md) makes the
issuer platform-owned, delivers it in `managedEnvironment` on both clouds, and refuses a variable the
app's artifact does not declare instead of storing one that does nothing. `backlog/76` is consumed and
deleted.

### Rolling the rename onto the live installation (2026-08-19)

`v0.0.15` published, `fabrika.ref` bumped, the example mirror pushed, `notes/prod` re-registered
against the new descriptor and redeployed. The refusals ADR-0035 specifies were witnessed against the
live control plane, each with its own message:

```
apps variables put FABRIKA_IAM_ISSUER  → 400 application variable "FABRIKA_IAM_ISSUER" is managed by Fabrika
apps variables put NOTES_NOT_DECLARED  → 400 application variable "NOTES_NOT_DECLARED" is not declared by notes/prod
```

**The rename then took the namespace down, and it exposed a real defect rather than a slip.** The
deploy succeeded — migrations applied, `notesapi` reached `ACTIVE` — but every route answered 502,
because `syncZeropsProxy` had rebuilt the namespace proxy from `main` as it does on every deploy, and
the new binary refused to boot: `ProxyEnvError: FABRIKA_IAM_ISSUER is required`. The proxy's own
variable was still `FABRIKA_IAM_URL`, written once when the namespace was provisioned.

So the one step that can hand a proxy NEW CODE was the one step that never wrote that code's
CONFIGURATION — those two variables belonged solely to `ensureProxyConfiguration`, which runs on
namespace provision and reconcile. Fixed by giving both paths one `ensureNamespaceProxyIam` and
calling it before the pipeline is triggered: configuration first, then the code that reads it. That
ordering is what ADR-0024 assumes when it forbids transitional fallbacks and calls a rename a flag day.

The live proxy was repaired by hand — the new name written, the old one removed — before the fix
existed, because the namespace was down. A sixth defect, in the same series as the five above, and the
only one whose blast radius was a whole namespace rather than one deploy.

Verified on `v0.0.16` by the step that had broken it. The deploy's process order in the notes project
is the whole property, read back from the account:

```
14:24:47 → 14:24:50  stack.updateUserData   the proxy manifest
14:24:51 → 14:24:54  stack.updateUserData   the proxy's IAM key (the issuer already matched, so skipped)
14:24:56             stack.build            the proxy rebuild
```

Two writes COMPLETE before the build starts; the run that took the namespace down had one. Proxy
app-version 12 is `ACTIVE`, and the namespace answered `200` on `/healthz` and `302` to IAM throughout.

### The private half stalled on `Verify installation` (2026-08-20)

The operator reached `installation-required` for `contember`, granted the App **all repositories** in
GitHub, and the console answered a bare `502`. **That symptom is still unexplained** and it is worth
saying so rather than claiming the fixes below caused it: a naked status can only come from the RPC
client's non-JSON branch (`app/src/client.ts`), so a proxy produced it and the control plane never
answered — most likely a click that landed inside the `v0.0.16` control rollover. It needs one more
attempt to settle.

Reading for it found two defects anyway, neither reachable from the console's own message.

**The legacy source binding did not survive a restart.** `GITHUB_APP_CREDENTIALS` carries an App id
and a private key and nothing else; the connection id and the App identity are set only by `activate`,
in memory. `status` could recover them from GitHub, `requireActive` — the gate on `verifyInstallations`
and `configureWebhook` — could not, and answered `credentials_conflict`. The source service runs
**more than one container**, so the console's `status` binds one while the operator's next click lands
on another, and every platform deploy replaces all of them. One `bindActive` now serves all three
operations. The regression test fails on the previous implementation at exactly that line.

**And the control plane discarded the reason.** `verifySourceInstallation` caught the source call's
failure and threw a naked 502, logging nothing, which is why the above took hours against container
logs that do not record it either. It now reports the port's `code` and `status` — read structurally,
never `error.message`, because a message can carry a credential and two such fields cannot. The
manifest exchange keeps a cause-free message on purpose: it carries the one-time manifest code.

A third, unrelated: `"lopata": "latest"` against `--frozen-lockfile` failed CI twice in a day on
commits that touched no dependency. Pinned to `^0.21.0` in all three packages, which also ended the
workspace carrying two versions of one dev tool. `backlog/77` is consumed and deleted.

## The multi-connection path had never once completed (2026-08-20)

The operator reported the console still stuck. Two states, in sequence: `Verify installation`
answered a bare `502`, and after a fresh setup the chain settled on `Private source: repair
required` with `Repair connection` locked on its pending label.

Caddy's access log on the platform proxy settled what the console could not. The two clicks are
there — `POST /api/rpc`, referer `/settings/source`, **`duration 0.163s`, `size 83`,
`status 502`**. Eighty-three bytes is exactly
`{"error":{"type":"source_connection","message":"source connection request failed"}}`; the other
candidate message is 88. So control answered, in JSON, in 163 ms. Not a timeout, not the proxy — a
fast deterministic refusal, which is the opposite of what the earlier reading of that `502` assumed.
Recording it here because the wrong inference cost a day: **a bare status in the console is not
evidence of a non-JSON response** when the dashboard renders `cause.message` and the message is the
default one.

**The root cause was a URL grammar, and it was total.** `buildZeropsSourceWebhookConfigureRequest`
and its response twin validate the webhook URL against the literal path `/webhooks/github`. That is
the legacy single-connection route. Since multi-connection landed, control derives
`/webhooks/github/<connectionId>` for every setup that is not an adoption, so one App's deliveries
cannot be replayed against another connection. `configureWebhook` therefore **rejected its own
request and its own response**, every keyed connection, always. Setup stopped at
`webhook_secret_stored`, settled to `repair_required`, and the resume hit the same wall. The path
could not have worked once.

No test reached it: the unit tests built the response with the legacy URL only, the source-service
tests stub the client, and the local-stack fixture builds the scoped URL without passing it through
the protocol builders. The grammar now takes one path segment matching `ID_PATTERN`, which has no
`%`, so a percent-escape fails rather than round-tripping.

**Second defect, found while proving the first.** `bindActive` — the fix from the previous section —
rebound only the _legacy_ snapshot. A keyed slot restored from the environment carries no App
identity, because `create()` builds it from the bundle alone, so every keyed operation fell through
to `this.active`, whose digest belongs to a different App, and could only answer
`credentials_conflict`. `statusV2` had always done this correctly, which is precisely why `status`
worked while `configureWebhook` and `verifyInstallations` did not — and why the earlier reading
blamed container restarts. A keyed connection worked exactly as long as the container that ran
`activateV2` stayed up. The fallback was wrong on its own terms too: binding a keyed connection
through the legacy App answers for the wrong App instead of failing.

Both fixes were reverted one at a time against the new test, which fails with `credentials_invalid`
(422) without the grammar and `credentials_conflict` without the keyed bind.

**Two more that turned a broken flow into an unreadable one.** `repairSourceConnection` caught the
resume failure, marked the attempt `repair_required` again and returned **200 with the unchanged
DTO** — success to every caller, so the console re-rendered the same red lamp with no reason, and
the button, which cleared its pending state only on the error path, locked. And every long-running
`Bun.serve` took the default `idleTimeout` of 10 s while allowing far more — the source client
permits 30 s per call and the configuration deadline is five minutes. A handler slower than the
default loses its connection mid-flight and the proxy answers `502` with no body. Verified locally:
a 15 s handler is cut at ~12 s with no response. `runner-container` had already set `idleTimeout:
255` for this reason; the other four now match it.

Live on `v0.0.18`: repair answered **`200` in 0.94 s** and the chain moved to
`GitHub App ✓ · Private source: credentials active ✓ · Webhook: awaiting repository grant`.
`Verify installation` now answers **`409`, 88 bytes** — `GitHub App installation is incomplete` —
which is the correct answer to an App that exists but is not yet installed on the organization, and
the first time this flow has named its own state instead of a number.

## The private repository deployed on the live installation (2026-08-20)

The first real private-source run, `01a01f03-445b-70d5-86ae-cc54dbeed844`, failed before checkout:
`resolve-v2` answered `404 installation_not_found`. Control had correctly bound `notes` to the sole
`contember` connection, `01a00085-40d6-70df-a62d-6bb0d15f0a9a`, and GitHub still reported App
`fabrika-test` installed for all repositories as installation `154387356`. The missing object was the
source credential slot for that connection. The console nevertheless labelled the database row
`Connected`: the collection query projects stable rows without calling source, despite the living
reference saying every status read compares source identity and digest.

The connection and the legacy source credential were created sixteen seconds apart on 14 August and
name the same GitHub App. The legacy bundle therefore still held the exact key material needed by the
missing keyed-v2 slot. Recovery constructed the canonical v2 bundle with the existing connection id,
created only the absent derived environment key as sensitive, and restarted only `source`. It did not
delete or re-register `notes`, change its sticky source binding, create a new App, or replace another
credential slot.

Run `01a01f10-c0ea-703f-b26c-9500b10435d6` is the live positive witness. Against the still-private
`contember/fabrika-example-zerops` repository it resolved commit
`6b686fc35d4f44debd4f0725478f8e7fe9faff8e`, finished the Zerops build, activated app version
`z93o2XEBSLiAbNiRg6ri2A`, and reached `succeeded`. The deployed `/healthz` answered `200`. Inspection
of the version metadata found no private-key marker, GitHub token prefix or credential-bearing GitHub
URL.
