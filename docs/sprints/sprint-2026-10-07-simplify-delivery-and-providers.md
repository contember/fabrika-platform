<!--
On close, prepend an OUTCOME block here, then `git mv` this file to ../archive/:

> **OUTCOME — shipped YYYY-MM-DD.** <one-paragraph result.> Commit map: WU1 → <sha>,
> WU2 → <sha>, … Verification: <the gate command + numbers>. Backlog closed:
> <ids deleted/rescoped>. Deferred: <honest notes>.
-->

# Sprint — Simplify delivery and provider packaging (2026-10-07)

**Goal.** Cut the delivery path, the provider seam and the package layout down to what a small fleet
on Cloudflare and Zerops needs, and rewrite the decision record so it describes that system directly.

**Theme.** The 2026-09-28..10-05 runs added distributed-systems machinery (fencing, checkpoint CAS,
version-bound managed env, a source-protocol handshake) and ~17k lines of tests around it, while the
provider-neutral core still branches on `'zerops'` and every cloud is spread over 4–5 packages. Success:
fewer hops per deploy, no provider names in shared control code, one public package per cloud plus its
private deployables, and an ADR set with no superseded entries. Feature set is unchanged — including
**multiple private GitHub source connections** (ADR-0029 stays in substance).

## Refs re-verified at HEAD (2026-10-07, `6090968`)

- ✔ Deploy lease TTL is 30 min although renewal exists — `packages/control/src/run-ownership.ts:5`.
- ✔ A shared Control route imports the Cloudflare runner — `packages/control/src/api/runs.ts:4`.
- ✔ The runner Worker writes Control's `runs` row with copied SQL — `packages/control/src/db/runs.ts:258` ("DUPLICATED verbatim").
- ✔ Shared Control code branches on the provider name — `packages/control/src/webhook.ts:65`, `packages/control/src/api/registry/apps.ts:103`.
- ✔ Required Zerops ids/URLs default to `''` on malformed responses — `packages/provider-zerops/src/api/client.ts:31-49`.
- ✔ Version-scoped managed secrets are never reclaimed — `docs/decisions/0044-…md:71`.
- ✔ `source` holds GitHub App credentials as keyed env slots on its own Zerops service — `packages/source-zerops/src/config.ts:35-75`; Control drives them over RPC — `packages/control/src/node/source-connection.ts:10-47`. Control already owns a vault — `packages/control/src/vault.ts`.
- ✔ `installation-zerops/zerops/` mixes runtime code, dev-time codegen importing private packages, and generated output; npm exclusion is a hand-kept `files` deny-list — `packages/installation-zerops/package.json:12-19`.
- ✔ `installation-cloudflare` already relaxes the same two strict flags as `provider-cloudflare` (root `CLAUDE.md`), so merging them widens nothing.
- ⚠ The paused readiness sprint (`sprint-2026-09-23-zerops-production-readiness.md`) records user approval of the ADR-0044 version binding. This sprint **replaces** that approach (Decision D3); its WU1 is rescoped, its other WUs stand.

## Decisions

- **D1 — ADRs are living until 1.0.** Rewrite a decided ADR in place when the decision changes; delete
  superseded ADRs after folding any reasoning still worth keeping into the survivor. Numbers stay stable
  (no renumbering — ~170 code/doc references cite them); gaps are fine. `docs/CLAUDE.md` and
  `decisions/README.md` change accordingly. Rationale for rejected alternatives stays in each ADR's
  Alternatives section; history stays in git.
- **D2 — No backward compatibility for persisted delivery state.** There is no production installation.
  Old `provider_state_json` phases, retained checkpoints, managed-env markers and the `source` service are
  not migrated; the disposable test project is reinstalled. Schema changes are new migration files (ledger
  identity per ADR-0017 is untouched).
- **D3 — Version only the release identity on Zerops.** Other managed keys (IAM issuer, Operations
  credentials) change only on platform reconfiguration and a newer value reaching older code is benign.
  Accepted risk: a rollback runs with the current, not the historical, non-release keys.
- **D4 — Zerops recovery does not resume.** Record `appVersionId` before upload; on restart or
  cancellation either poll that version to a terminal state or delete it and fail/cancel the run.
- **D5 — One lease primitive.** Holder-checked, renewed, TTL ≈ 90 s (renew every 30 s). Writes check the
  holder; no checkpoint compare-and-swap, no per-run DB poll loop. Runs and namespace-proxy attempts use it.
- **D6 — `source` merges into Control.** GitHub App credentials of every connection live in Control's vault,
  as on Cloudflare. The `source` service, its RPC key, the V2 wire protocol and env-slot activation go away.
  Keyed multi-connection semantics (ADR-0029) are kept.
- **D7 — Keep the separate Cloudflare runner Worker.** It stays a deployable; only its contract and its
  direct D1 write go.
- **D8 — Package target.** Per cloud: one public `provider-<cloud>` with subpaths
  (`.` authoring, `/control`, `/installation`, plus `/runner` on Cloudflare) and private deployables
  (`runner-cloudflare`, `runner-container`). Zerops installation codegen moves to a private
  `platform-artifacts`. `engine` is deleted; `installation-contract` becomes `provider-contract/installation`;
  `runner-contract` folds into `provider-cloudflare/runner`. Package renames to `@fabrika/<cloud>` are out
  of scope.

## Work units

### Phase 0 — Decision record (docs only, lands first)

#### WU0.1 — Make ADRs living (S)

- **Scope.** Rewrite the ADR rules in `docs/CLAUDE.md` ("Decisions", "Things NOT to do", source-of-truth
  notes) and `docs/decisions/README.md` per D1. Template keeps `status: accepted | proposed`; drop `superseded by`.
- **Acceptance.** No doc still says ADRs are immutable.

#### WU0.2 — Consolidate and rewrite ADRs (M)

Survivor keeps its number; the others are deleted after their live reasoning is folded in. Every ADR is
written in the **target** state of this sprint (code catching up is normal per `docs/CLAUDE.md`).

| Survivor                                     | Absorbs (deleted)                  | Rewrite                                                                                                                                                      |
| -------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0022 proxy is the only enforcement point     | 0007, 0008, 0010, 0021             | Fold surviving rationale into Context/Alternatives                                                                                                           |
| 0023 one session per host                    | 0026                               | Browser-bound handoff becomes a section                                                                                                                      |
| 0024 canonical environment names             | 0018                               | One ADR: names + no fallback                                                                                                                                 |
| 0011 static provider bundles                 | 0002, 0009                         | No engine, no runtime envelopes; one `deploy()`/`resolveSource()` with optional binding; capability flags instead of provider-name checks; D8 package layout |
| 0029 GitHub sources (retitled)               | 0030, 0031, 0032, 0036, 0037, 0039 | D6: in-process in Control, vault-held keyed credentials, multiple connections, tarball streaming, creation persisted before success, binding recovery        |
| 0044 Zerops managed configuration (retitled) | 0046, 0047                         | D3 + D4 + D5                                                                                                                                                 |
| 0048 Cloudflare commit binding               | —                                  | SHA checkout + HEAD check; no source-protocol handshake                                                                                                      |
| 0003 no runner on Zerops                     | —                                  | Drop the ADR-0029 amendment wording; Control runs the whole Zerops path in-process                                                                           |
| 0001 merge propustka and vozka               | — (deleted)                        | History only; git holds it                                                                                                                                   |

All others are kept and only have their cross-references fixed.

- **Verify first.** `grep -rn "ADR-00NN\|00NN-"` for every deleted number across the **whole repo**.
- **Acceptance.** No ADR has `superseded`; every reference to a deleted ADR points at its survivor;
  `docs/INDEX.md`, `decisions/README.md`, root and package `CLAUDE.md` files updated.

#### WU0.3 — Rescope related docs (S)

- Readiness sprint: replace WU1's approach with D3/D4, note the dependency on this sprint.
- Backlog: delete or rescope 37 (managed env activation → D3), 81 (keyed deploy in local stack → after
  WU4.1), 84/95 (lease/fencing → D5), 88/89 (runner) — each checked against its text first.
- Delete process-only docs: `docs/archive/static-validation-{territories,exceptions,local-integration}.md`.
- Add to `docs/CLAUDE.md`: reasoning goes in commit/PR bodies; sprint docs carry a plan and a short run log, not evidence ledgers.

### Phase 1 — Quick fixes (parallel, disjoint files)

#### WU1.1 — Lease TTL and smoke (S)

- **Scope.** TTL 90 s / renew 30 s; delete the natural-expiry smoke stage (`packages/local-stack/src/smoke.ts:339-359,459`) and `lease-wait.test.ts`.
- **Acceptance.** A test kills the holder and re-acquires within TTL + one renew period.

#### WU1.2 — Seam leaks and dead code (S)

- **Scope.** Drop the `runner-cloudflare` import in `api/runs.ts`; delete unused `Cloudflare*Envelope` in `control-contract/src/index.ts:191-205`; move `provider-cloudflare` to devDependencies in `iam` and `operations`; `control/src/platform-cf.ts` imports from `provider-cloudflare/runner`; move `provider-zerops/src/namespace-command.ts` into `@fabrika/cli`; rename `control/src/node/` → `control/src/zerops/`; mark `builder` Zerops-only in its docs.
- **Acceptance.** `bun run typecheck`, `release:validate`; `grep '@fabrika/runner-cloudflare' packages/control/src/api` is empty.

#### WU1.3 — Local-stack and test cleanup (S)

- **Scope.** Remove emulator snapshot back-compat (`legacy-emulator.json`, legacy branches in `zerops-emulator/snapshot.ts`); replace relative imports into other packages' `src/` with package exports; delete tests that only exercise zod (`static-validation.test.ts`, `wire-contracts.test.ts`); review the other "legacy" branches (builder/canvas draft recovery) and delete those with no installed data behind them.
- **Acceptance.** `bun run test` green; `grep -rn "\.\./\.\./[a-z-]*/src" packages/local-stack` empty.

#### WU1.4 — Unresolved webhook egress draft (dropped)

- The draft at `/tmp/opencode/fabrika-wu4-paused.patch` no longer exists; the readiness sprint records the loss. Its WU4 stays a release blocker there.

### Phase 2 — Boundaries and types

#### WU2.1 — Zerops response readers (M)

- **Problem.** 47 `z.preprocess` + 8 `prop()` copies; required ids `.catch('')`.
- **Scope.** Plain `z.object`; required fields required; `.catch(undefined)` only on optional fields; status fields as `z.enum(...).catch(undefined)`; one helper for `exactOptionalPropertyTypes` cleanup. Brand `ZeropsServiceId`/`ZeropsProjectId` at parse time.
- **Acceptance.** A reader test: a response missing `id` fails to parse instead of yielding `''`.

#### WU2.2 — One schema per shape (M)

- **Scope.** App vocabulary schema once in `@fabrika/auth`; gate rule from `proxy-contract` (+ refine); run log line and runner status schemas in the contract packages with `z.infer` types; one Sentry event schema in `operations`; one `RequestError` + `instanceof` replacing 4 duck-typed checks; strip instead of `.passthrough()` on internal protocols; remove double validation (`compileFabrikaManifest`, manual key check after `.strict()`, proxy-manifest re-parse → exported invariant checks); comment `github-app` permissions strictness.
- **Acceptance.** Each shape has one definition (grep); typecheck and tests green.

#### WU2.3 — Provider-neutral Control (M)

- **Scope.** Merge `*WithBinding` into `resolveSource`/`deploy` with optional `sourceBinding` and delete the `Map` side channel (`provider-zerops/src/control.ts:256,608-617`); neutral `registry.getSourceBinding()`; replace `provider === 'zerops'` in `webhook.ts`, `api/registry/apps.ts`, `db/registry.ts` (incl. SQL) with a provider-declared source mode; `transportKind` leaves `provider-contract`.
- **Acceptance.** `grep -rn "'zerops'\|'cloudflare'" packages/control/src --include=*.ts` outside the two composition roots is empty.

#### WU2.4 — Runner outcome through Control (M)

- **Scope.** Runner Worker stops writing `runs` (`runner-cloudflare/src/finish-run.ts`); Control applies the outcome from the runner's `status.json` in its reconcile/poll path under the lease guard. Delete `recordFailureOverRunnerSuccess`. The same path applies the outcome's IAM reconcile, so a Control self-deploy no longer loses it (consumes backlog 88).
- **Acceptance.** Test: runner finishes while Control is unavailable; next reconcile settles the run once and applies its IAM reconcile once.

#### WU2.5 — Console knows the provider (M)

- **Scope.** RPC exposes the installation's `provider.id`; "new app" and "add environment" pick their form by it (`dashboard/src/routes/apps/new.tsx:59`, `EnvironmentsSection.tsx:249`).
- **Acceptance.** Browser scenario for both forms on the local (Zerops) stack; unit test for the Cloudflare form selection.

### Phase 3 — Delivery machinery (serial)

#### WU3.1 — Shrink the provider contract, delete `engine` (L)

- **Scope.** Remove `RuntimeProvider`, `ProviderModule`, `createProvider`, runtime envelopes, session/plan/job types and `dependsOn`; each provider runs its steps in a plain `deploy()`; `normalizeRegistration` optional; delete the 12-coordinate check (`run-lifecycle.ts:356-375`); Cloudflare executor CLI calls the provider directly.
- **Acceptance.** `packages/engine` gone; CF `--dry-run` and Zerops deploy tests green; Cloudflare runner image builds.

#### WU3.2 — Zerops deploy and recovery per D3/D4 (L)

- **Scope.** Version only `FABRIKA_RELEASE`; plain overwrite for the other managed keys; delete ownership markers, admission (`managed-environment/protocol.ts`, `admission.ts`, `cleanup.ts`); one checkpoint (`appVersionId` + `triggered`); reconcile = poll or delete.
- **Acceptance.** Tests: crash before trigger → version deleted, run failed; crash after trigger → run settles from poll; cancel before trigger → cancelled. Live `platform-facts` rows for version deletion still pass.

#### WU3.3 — One lease primitive per D5 (M–L)

- **Scope.** Collapse `RunOwnership`, `NamespaceOwnership`, `proxy-attempt.ts` and terminal-release-repair CAS onto acquire/renew/holder-checked write; read cancellation at step boundaries; make the unguarded `mutateRun` path impossible; move `control/src/zerops/zerops-proxy.ts` behind a `namespaces.republish` capability in `provider-zerops`. The Operations catalog sync lease uses the same TTL and renewal (consumes backlog 84).
- **Acceptance.** Concurrency tests: two holders, one wins; cancel during a step stops at the next boundary; namespace republish and app deploy serialize; a dead catalog-sync holder blocks for at most one TTL.

#### WU3.4 — Cloudflare commit binding without handshake (M)

- **Scope.** Keep SHA checkout + HEAD verification in `runner-container`; delete `assertRunnerSourceProtocol` and the capability exchange; trim ref-resolution to what `resolveSource` needs.
- **Acceptance.** Existing mismatch test (wrong HEAD fails before install) stays green.

#### WU3.5 — Run logs (S–M, optional)

- **Scope.** Stop rewriting the whole `logs.ndjson` per line (`run-lifecycle.ts:102-109`); batch or append-chunk.

### Phase 4 — GitHub sources inside Control

#### WU4.1 — Merge `source-zerops` into Control (L)

- **Scope.** Move tarball streaming, metadata and keyed connections into `control/src/source/`; credentials in the vault (D6); delete `source-client.ts`, `source-connection.ts` env-slot activation, `FABRIKA_SOURCE_RPC_KEY`, the `source` service from `installation-zerops/zerops/topology.ts`, and the `source-zerops` package; regenerate `zerops.yaml` and import YAMLs; local stack drops the `source` container.
- **Acceptance.** Local stack: private keyed deploy from two connections (backlog 81 — a GitHub double for keyed deploys — stays separate); upload streams without buffering (existing tar tests moved); `local:smoke` green.

### Phase 5 — Packages

#### WU5.1 — Private `platform-artifacts` (M)

- **Scope.** Move `render.ts`, `proxy-manifest.ts`, `console-schema.ts`, `schemas/{refresh,check}.ts` out of `installation-zerops`; runtime `zerops/*` → `src/topology/`, generated TS → `src/generated/`; delete the `files` deny-list and private devDependencies; release smoke imports every public package from its tarball.
- **Acceptance.** `gen:check`, `release:validate`, `release:pack` + smoke green.

#### WU5.2 — Fold contracts (S)

- **Scope.** `runner-contract` → `provider-cloudflare/runner` (update `runner-container/Dockerfile` COPY list); `installation-contract` → `provider-contract/installation`.

#### WU5.3 — Merge installation into provider (M)

- **Scope.** `installation-<cloud>` → `provider-<cloud>/installation`; `cli` loads `@fabrika/provider-<cloud>/installation`; keep the open installation contract.
- **Acceptance.** `fabrika platform plan|deploy --provider=…` work from packed tarballs; `deptective` clean.

### Phase 6 — Close

#### WU6.1 — Reference and agent docs (M)

- **Scope.** Update `docs/reference/{overview,provider-bundles,portability-surface,installing-on-zerops,local-development}.md`; shrink `zerops-platform.md` to facts still load-bearing; update root and package `CLAUDE.md` (structure, invariants); `source-zerops` and removed packages gone from every map.

#### WU6.2 — Full verification (M)

- **Gate.** `bun run typecheck`, `lint`, `format:check`, `test` with `FABRIKA_TEST_POSTGRES_URL` and `FABRIKA_TEST_S3_*` set, `local:smoke`, `test:browser`, `release:validate`/`:pack`/`:smoke`, live `platform-facts` against the test project. Report LOC before/after per package.

## Out of scope (explicit)

- Folding the Cloudflare runner Worker into Control (D7).
- Moving composition roots out of `@fabrika/control`; renaming packages to `@fabrika/<cloud>`.
- Typing `canvas-kernel/src/engine/compiler.ts`; broad branded ids beyond the Zerops boundary.
- The readiness sprint's HA topology, source-map and webhook work, (the webhook egress draft is lost; see the readiness sprint).

## Sequencing

| Order | Units                                            | Parallel?                                                      |
| ----- | ------------------------------------------------ | -------------------------------------------------------------- |
| 1     | Phase 0 (WU0.1 → WU0.2 → WU0.3)                  | serial, one author                                             |
| 2     | WU1.1–1.3                                        | parallel                                                       |
| 3     | WU2.1, WU2.2, WU2.4, WU2.5                       | parallel; WU2.3 after WU2.1 (same Zerops files)                |
| 4     | WU3.1 → WU3.2 → WU3.3; WU3.4 and WU3.5 alongside | serial core                                                    |
| 5     | WU4.1                                            | after Phase 3 (shares Zerops deploy code)                      |
| 6     | WU5.1 → WU5.2 → WU5.3                            | serial (WU5.3 needs WU5.1 to avoid a control ↔ provider cycle) |
| 7     | WU6.1, WU6.2                                     | last                                                           |

## Run log

<!-- Append as you work. -->

- 2026-10-07 — Orchestration gate approved: phases 0–6, Claude reviewers, single tree, one commit per unit. WU1.1 and WU1.2 run as one unit (shared Control files). WU1.4 dropped: patch lost. Backlog 37 consumed by D3; 88 folded into WU2.4; 84 folded into WU3.3; 81 stays separate.
- Phase 0 → `39f8212` (living-ADR rules), `4536a7e` (31 ADRs remain; 17 absorbed or deleted), `c65939e` (code references repointed; migration files untouched).
- Phase 1 → `c68a2bb` (builder/canvas compat for unreleased formats), `92d8346` (lease 90 s, provider leaks, `fabrika namespace` in cli), `07a336f` (emulator strict state, smoke uses the maintenance cron after lease expiry, zod-only suites dropped with behaviour cases moved). Gates: typecheck, `bun run test` 4268 pass / 0 fail, `local:smoke` exit 0.
- Deviation: the `control/src/node/` → `zerops/` rename moved to WU5.1 (it changes generated `zerops.yaml` paths and the local compose file).
- Deferred: `fabrika namespace` (cli) overlaps `fabrika control namespaces`; only `adopt` is unique. Removing it is a feature change — owner decision.
- ADR review finding: D6 said "as on Cloudflare", but Cloudflare holds its single App key as Worker secrets, not in the vault. ADR-0029 now states the Zerops composition uses the vault and Cloudflare keeps Worker secrets.
- Phase 2 → `8a182c7` (Zerops readers), `3294db9` (one vocabulary/gate schema), `bf85154` (error guard, Sentry schema, string arrays), `dd3205f` (console picks forms by provider), `dd7235a` (source capability replaces provider-name checks), `b2935a1` (runner outcome only through Control; backlog 88 consumed). Gates: typecheck, `bun run test` 4303 pass / 0 fail, Postgres suites (control/iam/operations/platform-node) green, `local:smoke` exit 0.
- Decisions taken in phase 2: stored Zerops artifacts decode with the stricter vocabulary schema (D2); the console installation RPC needs authentication only; an IAM 4xx fails a Cloudflare run, an unreachable IAM keeps it in flight; the `fabrika namespace` response keeps `.passthrough()` (operator display).
- Owner action (outside the repo): deprecate `@fabrika/engine` on npm once WU3.1 ships.
- Phase 3 so far → `c488534` (engine and runtime contract deleted; shared `runSteps`), `15964c0` (Zerops binds only the release; poll-or-delete recovery; `managed-environment/` deleted), `56b3e6d` (Cloudflare source-protocol handshake deleted; runner preconditions checked before acceptance). Gates: typecheck, full suite with Postgres 4386 pass / 0 fail, `local:reset && local:smoke` exit 0 (smoke now asserts the built version's descriptor digest and setup from the emulator).
- WU3.3 split into 3.3a (lease primitive for runs, catalog, terminal repair) and 3.3b (namespaces, `republish`, delete `zerops-proxy.ts`). Namespace proxy codec stays strict (D2), no legacy `phase` mapping.
- WU3.3 → `6f89f2c` (one renewed lease for runs, catalog sync and terminal repair; inline settlement of an unfinished run; production −17 lines) and `9c1e7f8` (namespace proxy republish behind a provider capability; `NamespaceOwnership` and `zerops-proxy.ts` deleted; production −347, tests −473). Backlog 84 trimmed to its four remaining findings. Gates: full suite with Postgres, `local:reset && local:smoke` exit 0 after each unit.
- Decisions in WU3.3: an operator requeue survives a running lease holder (`claim` guard), and a reconcile request may move a `provisioning` namespace back to `pending` (state only); a namespace removed while its job runs stops that job as a lease loss.
- WU3.5 (run-log append instead of rewrite) deferred: a performance change, not a simplification.
- Phase 4 → `9d02105` (Control streams GitHub sources in-process; App keys in the vault; local stack without a source container) and `1600b85` (source service, package and wire protocol deleted; −9.8k lines). Gates: full suite with Postgres, `gen:check`, `release:validate`, `local:reset && local:smoke` exit 0.
- Found in WU4.1a: Bun's compression streams ignore backpressure, so the old source service buffered a whole repository in memory; `pullThrough` (control/src/source/streams.ts) fixes it.
- Decisions in phase 4: a leftover `source` service is only warned about; Control no longer receives `FABRIKA_ZEROPS_PROJECT_ID` (nothing reads it); an app whose connection binding dangles after the D2 migration must be deleted and re-registered.
