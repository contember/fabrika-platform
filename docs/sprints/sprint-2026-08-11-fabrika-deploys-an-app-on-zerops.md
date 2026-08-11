# Sprint — fabrika deploys an application on Zerops (2026-08-11)

**Goal.** The Delivery plane does the job it is named for on this provider: an application deployed by
**fabrika**, through the control plane, onto an installation fabrika built — and a browser signs into
it, and an exception it throws reaches the operator API.

**Theme.** Everything proven on Zerops so far is the platform _running_. The predecessor sprint
([archive](../archive/sprint-2026-08-07-zerops-from-scratch-install.md)) closed the last gap in getting
an installation up from an empty project, and the one after that closed `platform deploy`. None of them
deployed an **application**. The control plane's Zerops deploy path is fully written and unit-tested
against fakes, and its `trigger-deploy` step **has never built anything on a real account**, because it
passes no build source and nothing configures one. That is one step, and every remaining item on
[`05`](../backlog/05-bring-up-on-a-real-zerops-account.md) sits behind it.

This is the same shape as the last two sprints and should be read the same way: the value is in what
running it live finds, not in what the code looks like when it is written.

## Refs re-verified at HEAD (2026-08-11)

- ⚠ **The control-plane app path passes NO build source.** `trigger-deploy` calls
  `triggerPipeline({ …, buildFromGit: target.buildFromGit, … })` (`provider-zerops/src/provider.ts:190`),
  and the runtime target composed for a control-plane deploy never sets that field —
  `control.ts:263-270` carries only `projectId`, `serviceId`, `accessToken`, `apiBaseUrl`,
  `propustkaUrl`, `adminKey`. So the call takes the "build from the service's configured Git
  integration" branch (`api.ts:314-320`).
- ⚠ **Nothing configures that integration.** `external-repository-integration` appears nowhere in
  `packages/` or `examples/` — grepped, not assumed. This is what
  [`47`](../backlog/47-give-the-zerops-path-a-private-git-source.md) records, and it is **wider than
  that item states**: it blocks every control-plane app deploy on Zerops, not only private ones.
- ⚠ **The account still has no GitHub authorization.** `getGithubRepositories` →
  `Github authorization required`, checked 2026-08-11 — the same answer
  [`47`](../backlog/47-give-the-zerops-path-a-private-git-source.md) recorded on 2026-08-03. Only the
  account owner can change that.
- ✔ **A public build URL is an established mechanism here, not a new one.** The platform's own four
  services build from one: `buildFromGit` defaults to `FABRIKA_REPOSITORY_URL`
  (`installation-zerops/src/install-options.ts:123`), and the namespace proxy builds from a pinned tag
  of the same public repository (`provider-zerops/src/namespace.ts:860`).
- ✔ **The example app declares no build source**, and a test pins that:
  `expect(rec.triggers).toEqual([{ serviceId, buildFromGit: undefined, zeropsSetup }])`
  (`installation-zerops/zerops/__tests__/example-app.test.ts:286`). Whatever WU1 decides, that
  expectation changes with it.
- ✔ **The deploy plan is `apply-import → trigger-deploy → await-deploy → reconcile-schema`**
  (`provider-zerops/src/plan.ts:39-48`); the last step only when the app declares a schema and a
  `propustkaUrl` is configured.
- ✔ **Return origins and the Operations keys ARE projected on this path.** `reconcile-schema` PUTs the
  schema and then `setReturnOrigins` (`provider.ts:233,242-249`), and `FABRIKA_OPERATIONS_DSN` /
  `FABRIKA_RELEASE` are written as **service-scoped env vars before the plan runs**
  (`control.ts:234-262`), with `managedEnvironment: {}` passed into the run because Zerops has no
  runner to inject them. So WU4 is an observation, not new code — unless it is not.
- ⚠ **A Zerops run's build log never reaches the run record.** The provider relays it faithfully
  (`provider.ts:92-114`), but the control plane wires `events.log` to
  `console.info(\`deploy run ${run.id}: ${line}\`)`(`run-lifecycle.ts:314`).`markRunStarted`stamps`log_key = runs/<id>/logs.ndjson`and the read APIs serve that object (`api/runs.ts:154,176`), whose
  only writer is the **Cloudflare** runner relay (`runner-cloudflare/src/relay.ts:114`). Every Zerops
  run therefore answers`GET /runs/:id/log`with`{ lines: [] }`. No CLAUDE.md or ADR mentions this —
  it reads as an oversight, not a decision. → [`69`](../backlog/69-a-zerops-runs-log-never-reaches-the-run-record.md).
- ⚠ **Neither committed descriptor for the example names a database the light tier has** —
  [`60`](../backlog/60-the-example-app-has-no-light-tier-descriptor.md), unchanged.

## Work units

### WU1 — Give an app deploy a build source (effort M) · everything waits on this

- **Problem.** The refs above: no source is passed and no integration exists, so `trigger-deploy`
  cannot build. The step has never succeeded against an account.
- **Verify first.** One cheap live experiment before any code: an app's service spec may already carry
  `buildFromGit`, which the compiler copies into the import document
  (`provider-zerops/src/compile.ts:100-101`). Apply such an import by hand and trigger the pipeline
  **without** `buildFromGit`, exactly as `provider.ts:190` does. If the platform builds, the app config
  already holds the answer and this WU is small; if it does not, the source must be threaded to the
  trigger. Record the answer in `reference/zerops-platform.md` either way — it is a platform fact.
- **Scope.** Thread a public build source from the app's own configuration through
  `ZeropsStoredTarget` → `ZeropsRuntimeTarget` → `trigger-deploy`. Decide where it is authored: the
  app's `fabrika.config.ts` (the app knows its own repository) or the control plane's registration
  record (the installation knows what it is allowed to build). Prefer the app config unless the
  experiment says otherwise — it needs no schema change and no migration.
- **Scope guard.** A **public** URL only. A credentialed clone URL is refused by
  [ADR-0025](../decisions/0025-the-operator-installs-the-platform-fabrika-deploys-apps.md) because the
  platform persists what it is given, so a short-lived token becomes durable service state that
  expires. Do not reintroduce it; WU5 is the sanctioned path for anything private.
- **Acceptance / witness.** `POST /api/deploy` for `examples/zerops-app` against `fabrika-install-test`
  produces a Zerops app version that reaches **ACTIVE**, and the app answers on its own host. Not a
  green plan — a running application.
- **Touch points.** `packages/provider-zerops/src/{control,provider,types}.ts`,
  `packages/control/src/`, `examples/zerops-app/fabrika.config.ts`,
  `packages/installation-zerops/zerops/__tests__/example-app.test.ts`.

### WU2 — The example app names the database it actually runs against (effort S)

- **Problem.** [`60`](../backlog/60-the-example-app-has-no-light-tier-descriptor.md). Both committed
  descriptors interpolate a service the light tier does not have (`notesdb`, `postgres`); the tier has
  one shared `db`. A key a service declares in its own `zerops.yaml` conflicts with the env API on
  create and never appears in `GET /service-stack/{id}/env` — verified live, see
  `reference/zerops-platform.md`.
- **Verify first.** Which owner wins is the whole question. Before choosing, confirm on the target
  installation what happens when a descriptor declares a key the env API already owns.
- **Scope.** Decide how an app names a database it does not own, from the three candidates item 60
  already lists. ADR-0004's answer for every other per-installation value is "the env API owns it",
  which points at dropping the key from `run.envVariables` — but that makes the descriptor
  incomplete on its own, which is a real cost, not a detail.
- **Acceptance / witness.** The example deploys **from a clean checkout, with no file edited**, against
  the shared `db`, and reads and writes rows.
- **Touch points.** `examples/zerops-app/zerops*.yaml`,
  `packages/installation-zerops/zerops/topology.ts`, `docs/reference/zerops-platform.md`.

### WU3 — A Zerops run's log reaches the run record (effort S) · independent

- **Problem.** The ref above. The build log is relayed and then dropped into stdout; the run's log
  endpoint is empty for every Zerops deploy that has ever run. On Cloudflare the runner relay writes
  the object, so the console shows logs on one provider and nothing on the other.
- **Scope.** Write the relayed lines to the run's `log_key` object from the control plane, so the
  writer is the plane that owns the run rather than a provider-specific runner. Keep the stdout line —
  it is the only thing that works when the blob store is down.
- **Acceptance / witness.** `GET /runs/:id/log` for the WU1 deploy returns the Zerops build log, and the
  console shows it. Written against the live run, not a fixture.
- **Touch points.** `packages/control/src/run-lifecycle.ts`, `packages/control/src/api/runs.ts`.

### WU4 — The live acceptance: a signed-in app that reports its own errors (effort M)

- **Problem.** [`05`](../backlog/05-bring-up-on-a-real-zerops-account.md) items 3 and 4 have never been
  observed. The code that should make them true exists (see refs), which is exactly the condition under
  which the last three sprints each found defects.
- **Scope.** Observe, then fix what the observation breaks. Nothing here is planned code.
- **Acceptance / witness**, in order:
  1. A browser signs into the deployed app through the handoff — its return origin was registered by
     the deploy itself, not by hand.
  2. `FABRIKA_OPERATIONS_DSN` and `FABRIKA_RELEASE` are present **on the running service**, read back
     from the account (keys and non-secret values only).
  3. An exception thrown by the app reaches the private operator API and appears in the Operations
     console, correlated to the release the deploy recorded
     ([`36`](../backlog/36-complete-zerops-release-artifact-correlation.md) is the follow-on if the
     correlation is what breaks).
- **Touch points.** Unknown by construction. Anything it forces is the return on the sprint.

### WU5 — The repository integration, for apps that are not public (effort M) · blocked on the operator

- **Problem.** [`47`](../backlog/47-give-the-zerops-path-a-private-git-source.md). WU1 makes a **public**
  app deployable; a private one still cannot build, and neither can the Operations DSN that the
  control→Operations catalog projection mints for it.
- **Blocked by one thing only.** The Zerops account must authorize GitHub repository access — an OAuth
  pass the account owner performs. Verified still absent on 2026-08-11.
- **Scope.** `PUT /service-stack/{id}/external-repository-integration` on the API client; configure it
  when fabrika creates an app's service; take the integration branch of `triggerPipeline`. Per ADR-0025
  the integration is durable configuration fabrika sets, not a credential fabrika holds.
- **Acceptance / witness.** A private repository deploys through the control plane onto
  `fabrika-install-test`, and the same app's ingest reaches Operations.
- **Touch points.** `packages/provider-zerops/src/api.ts`, `packages/provider-zerops/src/control.ts`.

## Out of scope (explicit)

- **The production two-project shape and custom domains** — [`05`](../backlog/05-bring-up-on-a-real-zerops-account.md)
  items 1 and 2. This sprint stays on the light tier, on one installation.
- **`fabrika app deploy` for Zerops as a CLI verb.** The CLI accepts only `build` for the Zerops app
  area (`cli/src/index.ts:145-150`) and the control plane is the entry point by design. Widening the
  CLI is a separate decision, not a step here.
- **The Cloudflare install path**, which has still never been run. Same defect class as the last sprint
  found, one whole provider wide — but a different sprint.
- **[`67`](../backlog/67-command-for-the-first-administrator.md) and
  [`68`](../backlog/68-platform-commands-mishandle-a-closed-stdin.md).** `fabrika-install-test` already
  has an administrator, so neither blocks anything here.

## Decisions

1. **Public build source first, repository integration second.** Chosen deliberately over doing only
   one. The public path needs nothing from the operator and proves the whole Delivery chain end to end;
   the integration is the mechanism ADR-0025 actually settled and the only one that serves a private
   app. The risk accepted is two mechanisms in the code until it is clear whether the first stays — and
   it probably should stay, because the platform's own services already build that way.
2. **This is not a workaround around ADR-0025.** That decision rejected a **credentialed** clone URL,
   because the platform persists what it is handed and a one-hour token would become durable state that
   expires. A public URL carries no credential and is what `install-options.ts:123` already does for
   every platform service.
3. **Target `fabrika-install-test`.** It was created by `platform install` and nothing has been done to
   it by hand, so an observation from it means what it says. `fabrika-test` carries hand-written
   service env and a `notesapi` on an old build — which is what item 60 is about — so evidence from it
   would have to be qualified every time.

## Sequencing

|                                   | depends on                              | can run alongside |
| --------------------------------- | --------------------------------------- | ----------------- |
| WU1 (build source)                | —                                       | WU2, WU3          |
| WU2 (example descriptor)          | —                                       | WU1, WU3          |
| WU3 (run log into the run record) | —                                       | WU1, WU2          |
| WU4 (live acceptance)             | WU1, WU2                                | WU3               |
| WU5 (repository integration)      | **the operator's GitHub authorization** | anything          |

WU1's live experiment comes first and is cheap; it decides how big WU1 is. WU5 can start the moment the
authorization exists and is otherwise independent — do not let it block WU4.

## Run log

<!-- Append as you work. -->
