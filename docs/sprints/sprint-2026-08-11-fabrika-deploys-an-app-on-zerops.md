# Sprint — add a GitHub repository, get a deployed app on Zerops (2026-08-11)

**Goal.** An operator adds a GitHub repository — **public or private** — to the control plane, and
fabrika deploys it into the Zerops account. Nothing short of that counts as done.

**The gate.** This sprint has ONE acceptance criterion and every work unit exists to serve it:

> Register an app in the control plane naming a GitHub repository and an environment, trigger a deploy,
> and the application builds from that repository and runs in `fabrika-install-test`. Done **twice** —
> once with the repository public, once with the same repository private. Then a browser signs into it
> through the handoff, and an exception it throws reaches the private operator API.

A work unit that does not move that criterion is out of scope, however tempting.

**Blocked on the operator, for the whole sprint and not just one unit.** The private half needs the
Zerops account to authorize GitHub repository access — an OAuth pass only the account owner can
perform. Verified still absent on 2026-08-11 (`getGithubRepositories` → `Github authorization
required`). The public half can proceed without it; the gate cannot be closed without it.

**Theme.** Everything proven on Zerops so far is the platform _running_. Its predecessors got an
installation up from an empty project and taught `platform deploy` to run unattended from CI. Neither
deployed an **application** — the thing fabrika exists to do. The control plane's Zerops path is fully
written, unit-tested against fakes, and `trigger-deploy` has never built anything on a real account.

The pleasant surprise from scoping: **the control plane already holds the repository.** `apps.repo_url`
is required, `default_branch` defaults to `main`, the console form already asks for a GitHub URL, and
`runs.ref` is resolved on every deploy. Cloudflare consumes all of it. Zerops ignores all of it. So this
is mostly a wiring sprint with two live unknowns, not a design sprint.

## Refs re-verified at HEAD (2026-08-11)

- ✔ **The control plane already takes a repository, and it is not optional.** `apps` carries
  `repo_url`, `default_branch` (default `'main'`), `worker_dir`, `build_cmd`, `config_path`,
  `github_installation_id` (`migrations/0001_init.sql:33`, row shape `control/src/db.ts:18`); `repoUrl`
  is required on `CreateAppRequest` and `RegisterAppRequest` (`control-contract/src/index.ts:44,201`);
  the console form's second field is "GitHub repo URL" (`dashboard/src/routes/apps/new.tsx`).
- ✔ **A deploy already resolves a concrete ref.** `input.ref ?? concrete trigger_ref ?? refs/heads/<default_branch>`
  (`control/src/api/runs.ts:248-249`), stored on `runs.ref`.
- ⚠ **Zerops throws all of it away.** `ProviderDeployInput.app.source` reaches the Zerops control
  provider, which reads exactly one field off it — `cwd: input.app.source.workerDir ?? '.'`
  (`provider-zerops/src/control.ts:276`). `source.repoUrl` and `source.ref` appear nowhere in
  `packages/provider-zerops/src/`. The runtime target it composes omits `buildFromGit` (`control.ts:263-270`),
  so `trigger-deploy` takes the "build from the service's configured Git integration" branch
  (`provider.ts:183`, `api.ts:314-320`) — and nothing configures one.
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
- ⚠ **The account has no GitHub authorization.** `getGithubRepositories` → `Github authorization
  required`, 2026-08-11, the same answer [`47`](../backlog/47-give-the-zerops-path-a-private-git-source.md)
  recorded on 2026-08-03.
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

### WU2 — The Zerops provider reads the repository the control plane already has (effort M)

- **Problem.** `apps.repo_url` and the resolved `runs.ref` reach the provider and are dropped
  (refs above). This is the whole public half of the gate.
- **Scope.** Thread `input.app.source` into the Zerops deploy the way Cloudflare already does: derive
  the build source from `repoUrl` + `ref`, put it on `ZeropsRuntimeTarget`, and pass it at
  `trigger-deploy`. The codec bump belongs to the RUNTIME target, which is composed per run and
  persists nothing — prefer that over widening `ZeropsStoredTarget`, which would need a version 3 and a
  backfill for no gain.
- **Scope guard.** A **public** URL carries no credential. A credentialed clone URL stays refused by
  [ADR-0025](../decisions/0025-the-operator-installs-the-platform-fabrika-deploys-apps.md) — the
  platform persists what it is given, so a short-lived token becomes durable state that expires. WU3 is
  the sanctioned path for anything private.
- **Acceptance / witness.** A deploy triggered from the console against the **public** example
  repository builds and reaches `ACTIVE` in `fabrika-install-test`, and the app answers on its own host.
- **Touch points.** `packages/provider-zerops/src/{control,provider,types}.ts`.

### WU3 — The repository integration, and whether it replaces WU2 rather than joining it (effort M)

- **Problem.** [`47`](../backlog/47-give-the-zerops-path-a-private-git-source.md). A private repository
  cannot be built from a URL; the integration is the only path, and nothing in `packages/` configures
  one — `external-repository-integration` appears nowhere.
- **Verify first, and it is the sprint's most valuable question.** Does the integration also serve a
  **public** repository? If it does, fabrika needs ONE mechanism and WU2's URL path becomes a fallback
  worth deleting rather than a second code path to maintain. Measure it the day the authorization
  exists, before writing the second half.
- **Scope.** `SetupExternalRepositoryIntegration` on the API client; configure it when fabrika creates
  an app's service, from `repo_url` + `default_branch` + the manifest's `zeropsSetup`; take the
  integration branch at `trigger-deploy`. Per ADR-0025 the integration is durable configuration fabrika
  SETS, never a credential fabrika holds.
- **Acceptance / witness.** The same example repository, now **private**, deploys through the control
  plane into `fabrika-install-test`. Plus a recorded answer to the public question above, whichever way
  it goes.
- **Touch points.** `packages/provider-zerops/src/api.ts`, `packages/provider-zerops/src/control.ts`.

### WU4 — A failed build fails the deploy (effort S) · protects every other unit

- **Problem.** [`70`](../backlog/70-a-failed-zerops-build-hangs-await-deploy-for-seventy-minutes.md),
  found while scoping this sprint. A `stack.build` that fails before it creates a container leaves its
  app version at `WAITING_TO_BUILD` permanently, and `await-deploy` polls only the version, with a
  70-minute timeout.
- **Why it is in this sprint rather than the backlog.** WU2 and WU3 will each fail their first attempt
  in exactly this way — a wrong setup name, a repository the integration cannot see — and every one of
  those attempts would cost seventy minutes and report nothing.
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
3. **Prefer one mechanism to two.** If the integration serves public repositories as well, WU2's URL
   path is a fallback to delete rather than a peer to maintain. WU3 measures this before the code is
   written.
4. **The build source belongs on the RUNTIME target, not the stored one.** It is derivable from
   `apps.repo_url` + the run's resolved `ref` on every deploy, so persisting it would duplicate a
   registry field and cost a codec version.
5. **Target `fabrika-install-test`.** Created by `platform install`, untouched by hand, so an
   observation from it means what it says.

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

|                                     | depends on                    | can run alongside |
| ----------------------------------- | ----------------------------- | ----------------- |
| WU1 (repository-root ADR + example) | —                             | WU4, WU6          |
| WU4 (fail a failed build fast)      | —                             | WU1, WU6          |
| WU6 (run log into the run record)   | —                             | WU1, WU4          |
| WU2 (read the repository, public)   | WU1                           | WU3's measurement |
| WU3 (repository integration)        | WU1, **GitHub authorization** | —                 |
| WU5 (sign-in + Operations ingest)   | WU2 _or_ WU3                  | —                 |

WU4 and WU6 first even though they are not the gate: they are what makes the six live attempts after
them debuggable rather than seventy minutes of silence each. WU1 before both deploy units because it
decides what is being deployed. WU3's public-repository measurement happens as early as the
authorization allows, because a positive answer deletes half of WU2.

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

### GitHub authorization recheck (2026-08-11)

The operator completed a GitHub authorization in the browser, but the Zerops API identity used by the
installation still answers `githubAuthorizationRequired`. That identity is Zerops owner
`matejka@contember.com` (display name `David`) in the `Contember` organization. The authorization was
therefore either completed as another Zerops user or did not finish for this identity. WU3 remains
blocked until `getGithubRepositories` succeeds for the installation identity.

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

The GitHub authorization was checked again after this checkpoint and still returned
`githubAuthorizationRequired` for the same installation identity. No release was cut: the required WU3
public-repository measurement decides whether its integration replaces WU2's public URL path, and the
installation should roll out that decision once rather than deploy two competing mechanisms in turn.
