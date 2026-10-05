# Sprint — source identity and bounded provider cleanup (2026-10-05)

## OUTCOME — completed 2026-10-05

The approved implementation wave is complete on `main`. Both providers retain their native execution boundaries. Cloudflare verifies the selected commit before repository commands and binds the run, checkout, runtime release and source-map scope to that identity. Independent implementation, fix and reference reviews passed.

| Unit | Commit    | Result                                                                                                                          |
| ---- | --------- | ------------------------------------------------------------------------------------------------------------------------------- |
| WU1  | `4cbbe3a` | Export the existing neutral envelope decoder.                                                                                   |
| WU2  | `c3111d5` | Remove unread Zerops hostname state while retaining validation.                                                                 |
| WU3  | `f46752d` | Share the existing installation service lookup.                                                                                 |
| WU4  | `5ddf08d` | Consume the shared decoder in Zerops; retain codec cycles.                                                                      |
| WU5  | `bbbb8c1` | Resolve immutable Cloudflare source, admit compatible consumers, verify fresh exact checkout and preserve credential isolation. |

Final leader verification:

- Full suite with dedicated PostgreSQL 17 and SeaweedFS: **4,615 passed, 39 skipped, zero failures** (core 4,141; agent interfaces 310; builder 164).
- The skips are 37 opt-in live Zerops cases and two PostgreSQL-only concurrency cases skipped for the SQLite variant. PostgreSQL/S3 prerequisites were present.
- Root typecheck, formatting/check and lint passed. Lint retains the baseline 15 warnings and 1,305 informational diagnostics.
- All 11 generated Zerops artifacts are current. Release validation, packing and isolated-consumer smoke passed for all 28 public packages at disposable `v0.0.0-source-identity.0`.
- Native Git witnesses cover moved branches, SHA-named branches, unavailable objects, repeated-checkout refusal and dry previews. Joined lifecycle witnesses observe persistence, checkout bytes, runtime release and map upload scope for webhook, poll and manual runs.
- Both run-owned disposable backend containers were removed after verification.

C2 normalization reuse was explicitly deferred after selective hook/runtime aliasing disproved its isolation assumption. No codec cycle was removed, and the characterization is baseline compatibility evidence. Installation pin policy/UX and existing readiness work retain their separate decisions and owners. Public anonymous GitHub tag resolution was probed; private GitHub authorization, live Cloudflare RPC/image execution, Docker deployment and live provider parity were not established. No push, deployment or publication occurred.

## Original plan and execution record

**Goal.** Make Cloudflare application delivery use the recorded commit, and remove verified local duplication while retaining both provider paths.

**Theme.** Source selection, checkout, runtime release and source maps must agree. The accompanying cleanup keeps existing boundary validation and execution ownership.

## Refs re-verified at HEAD (2026-10-05)

Baseline: `243963ff046665de7dab9bc313924dce6a102593`, initially clean `main`.

- ✔ Cloudflare clone preparation can replace the source ref; there is no neutral source-resolution capability in its provider — `packages/provider-cloudflare/src/control.ts:194,232-243,311-366`.
- ✔ Control already resolves, compares and fences an immutable source before release projection when the selected provider implements that capability — `packages/control/src/run-lifecycle.ts:396-436`.
- ✔ The container follows a mutable ref and installs dependencies without checking HEAD — `packages/runner-container/src/runner.ts:374-434`.
- ✔ The contract's existing envelope decoder has two equivalent provider-local copies — `packages/provider-contract/src/provider.ts:29-37`, `packages/provider-cloudflare/src/control.ts:200-208`, `packages/provider-zerops/src/control.ts:92-100`.
- ✔ Zerops normalizes then immediately re-decodes its own output; artifact detachment is an observable constraint — `packages/provider-zerops/src/control.ts:466-467,524-535`, `packages/provider-zerops/src/manifest.ts:113-118`.
- ✔ Private hostname state has no reader; validation remains required — `packages/provider-zerops/src/provider.ts:249,673,679`.
- ✔ Installation provisioning and deploy duplicate the same lookup; their existing import direction allows reuse — `packages/installation-zerops/src/deploy.ts:225-231`, `packages/installation-zerops/src/install-provisioning.ts:185-191`.

The implementation specifications were prepared by four independent agents. Existing baseline checks are historical evidence, not verification of this sprint.

## Work units

### WU1 — Export the existing envelope decoder (S)

- **Problem.** Provider-local copies repeat the existing neutral discriminator checks.
- **Verify first.** Read the current helper, wildcard export and public provider tests.
- **Scope.** Export the unchanged function. Consumers follow in WU4/WU5.
- **Acceptance / witness.** Existing provider-contract tests retain exact errors and codec behavior; typecheck verifies the additive export.
- **Touch points.** `packages/provider-contract/src/provider.ts` and its existing tests.

### WU2 — Remove unread hostname state (S)

- **Problem.** Zerops stores a hostname that no step reads.
- **Verify first.** Inspect every `StepEnv` consumer and the hostname resolver.
- **Scope.** Remove the private field and assignment; retain the validating resolver call at the same point.
- **Acceptance / witness.** Existing runtime/provider tests retain invalid-hostname refusal and dry-run behavior.
- **Touch points.** `packages/provider-zerops/src/provider.ts`.

### WU3 — Share the installation service lookup (S)

- **Problem.** Two exact helper copies have the same types and missing-service error.
- **Verify first.** Inspect callers and the existing provisioning-to-deploy import direction.
- **Scope.** Export the deploy-owned helper and re-export it at the existing provisioning address.
- **Acceptance / witness.** Existing install/deploy tests retain service resolution, error behavior and effect ordering.
- **Touch points.** `packages/installation-zerops/src/deploy.ts`, `packages/installation-zerops/src/install-provisioning.ts`.

### WU4 — Reuse the shared decoder in Zerops (S; C2 deferred)

- **Problem.** The local decoder repeats the neutral implementation. The proposed adjacent-cycle removal had an incorrect artifact-detachment assumption.
- **Verify first.** Check all eight decoder callers and independently characterize current hook/runtime reference sharing.
- **Scope.** Use the shared decoder with the same kind strings, codecs, validation order and errors. Keep all normalization codec cycles; the user deferred C2 after reviewing its compatibility and complexity tradeoffs.
- **Acceptance / witness.** Existing provider behavior and exact-error/refusal tests pass. The hook characterization records baseline selective sharing, not successful C2 isolation.
- **Touch points.** `packages/provider-zerops/src/control.ts`, `packages/provider-zerops/src/__tests__/control.test.ts`.

### WU5 — Bind Cloudflare delivery to the selected commit (L)

- **Problem.** A run can record A while the container checks out a later branch tip B.
- **Verify first.** Independently review the plan; verify native Git argv with a real local origin; inspect all production and test compositions.
- **Scope.** Separate source resolution from clone authorization. Resolve recorded commit IDs or concrete refs through bounded GitHub data requests. Wire the existing neutral lifecycle. Require exact non-dry runner commits, authenticated Worker protocol admission and image admission before `/run`. Fetch the exact commit, detach HEAD and compare it before dependency installation. Keep Git authorization out of argv, persisted Git configuration and repository children. Reuse the shared decoder in the Cloudflare provider.
- **Acceptance / witness.** Real origin A → branch B → checkout A, plus missing-object/mismatch refusal, private credential isolation, cancellation and producer/consumer skew. A joined lifecycle/runner/artifact witness observes stored SHA, actual bytes, runtime release and upload scope independently.
- **Touch points.** Cloudflare provider Control/root exports; Control repository source/composition and lifecycle tests; runner Worker/relay; container runner/spawner/server; their tests and an offline joined Git test.

## Out of scope (explicit)

- Installation pin policy and `plan/admin/upgrade` UX need separate product decisions and an operator-owned live installation.
- Retain public `dependsOn` metadata, third-party installation loading, bound method shapes and current runtime-session APIs.
- No stateless registration move, new scheduler, provider registry, source service or dependency.
- C2 registration-cycle removal is deferred: hook pipeline arrays currently share runtime artifact identity while import-tree edits are detached. Placement-only reuse adds private seams for two fewer decodes without a demonstrated net simplicity benefit.
- No live-cloud mutation, push, deployment, publication or closure of the existing Zerops readiness sprint.
- Cloudflare readiness backlog 64/88/89 and Zerops readiness WU4/WU5/WU6 retain their existing owners and gates.

## Decisions

The user approved this bounded wave and the Cloudflare public contract change on 2026-10-05:

The durable source-identity and admission decision is [ADR-0048](../decisions/0048-bind-cloudflare-delivery-to-the-recorded-commit.md).

- `resolveSource` means immutable commit resolution; `prepareClone` means ephemeral clone authorization.
- Non-dry jobs use complete GitHub SHA-1 commits. Dry mutable-ref previews retain their separate release-unavailable behavior.
- Bare names resolve heads first, then tags only on not-found; qualified refs preserve namespaces. Recorded non-commit objects fail rather than silently changing recorded identity.
- Control checks an authenticated read-only Worker protocol capability before submission. The Worker checks the image's health capability before POSTing a job.
- The detached runner/image must precede Control in a future operator-owned CI rollout.
- Both providers retain the same observable source/release guarantees and their native execution mechanics.
- After the verify-first witness and independent review disproved full artifact detachment, the user approved deferring C2. Preserve current hook behavior and artifact/hash timing; isolate the hook only through a separate explicit contract decision.

## Sequencing

Single working tree, current branch, explicit disjoint territories. Agents never commit. The leader verifies and commits complete green units.

| Wave  | Work                                                                                          | Barrier                                             |
| ----- | --------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| 0     | WU1/WU2/WU3 in parallel; independent Cloudflare plan review                                   | Exported decoder and frozen source/runner contracts |
| 1     | Cloudflare source adapter, container checkout and WU4 in parallel                             | Local behavior and independent reviews              |
| 2     | Cloudflare provider/Worker/image/composition wiring                                           | Frozen consumers agree; old versions refuse safely  |
| 3     | Joined source/release/maps witness and independent full-change review                         | Integrated behavioral checks                        |
| Close | Root typecheck, lint, formatting, full tests, release validation/pack/isolated consumer smoke | All appropriate gates pass; archive with evidence   |

CPU-heavy checks use `cpu-lease`. Local Git witnesses need no cloud credentials. Passing skipped backend/live suites is not live parity evidence.

## Run log

- 2026-10-05: User approved the bounded wave and exact-source contract after specification review. Four completed specifications were preserved across the server restart; implementation started from the unchanged baseline.
- 2026-10-05: WU1 → `4cbbe3a`, WU2 → `c3111d5`, WU3 → `f46752d`. Each passed independent review. Leader verification: provider-contract 13/13; Zerops provider and installation install/deploy 143/143; root typecheck, scoped formatting and lint passed. Consumer packaging and the final full suite remain open.
- 2026-10-05: Dedicated ephemeral PostgreSQL 17 and SeaweedFS backends are ready. Leader backend setup check: S3 blob and real-PostgreSQL run-fencing suites, 17 passed, zero failures or prerequisite skips. These backends are isolated from other local stacks and will be removed after final checks.
- 2026-10-05: Independent Cloudflare step review confirmed exact native Git checkout and the old runner's SHA-named-branch counterexample. Plan corrections: settle known pre-POST image refusal through the existing failed runner outcome; preserve original deployment abort reasons on rejected awaits; put the joined witness in Control's existing typechecked test program. No API or scope change.
- 2026-10-05: C2 verify-first witness and independent review confirmed selective aliasing: hook pipeline edits reach the runtime artifact/checkpoint hash, while import-tree edits do not. No C2 production changes were made. The user weighed the options and approved deferral; WU4 now lands only shared decoder consumption and bounded regression evidence. Leader ran the pre-trim Control suite: 114 passed, zero failures.
- 2026-10-05: WU4 → `5ddf08d`. After user-approved C2 deferral, removed seven new fixed-point/phase cases and retained bounded decoder rejection and baseline hook-sharing witnesses. Independent final review passed. Leader verification: 107 Control tests, zero failures; package typecheck, formatting, lint and diff checks passed (one existing informational lint diagnostic).
- 2026-10-05: Cloudflare source, checkout and joined witness implementations are ready for independent review. Leader focused check: 233 tests across source/lifecycle/joined/runner/spawner/real-Git suites, zero failures. The joined witness observes stored A, moved branch B, detached HEAD A, runtime release A and map bytes/upload scope A for webhook, branch poll and manual runs; removed selected objects fail before repository commands. Final integration/typecheck and review remain open.
- 2026-10-05: Joined witness independent review passed. Source/runner reviews found four local defects: an uncooperative token-fetch wait, intermediate ref-component trailing dots, reused checkout contents, and the combined-redactor regex size limit. Original implementers own the bounded fix round. The source reviewer also verified anonymous public GitHub tag peeling and refusal of a recorded tag object; no private/cloud acceptance was exercised.
- 2026-10-05: Leader integration check: 120 tests across provider/composition/Worker/relay/server/protocol suites, zero failures. Generated Zerops artifacts and release validation for 28 public packages passed. Consumer-facing source-contract and rollout reference updates are prepared; final integration review and post-fix root gates remain open.
- 2026-10-05: Source/runner fixes passed leader verification: 240 focused tests, zero failures, including native repeated-job refusal and admitted large-secret redaction. Final fix reviews remain open. Integration review found three bounded admission defects: DO RPC loses redirect history, diagnostic R2 failures can bypass known-undispatched terminal settlement, and Control's capability wait lacks a finite deadline. U0 owns the local fixes.
- 2026-10-05: All 28 public packages packed at disposable `v0.0.0-source-identity.0` and passed isolated-consumer smoke. Documentation review required qualifying the exact-source guarantee as non-dry; the reference updates now do so. No publication or account deployment occurred.
- 2026-10-05: U0 admission and U2 checkout/redaction final reviews passed. Cached literal occurrences remove the confirmed second-scale short-token log stall without a regex, dependency or new API. Source review identified a final queued-abort body-handoff race; its fix remains local to deployment token preparation. Leader source/admission check: 287 passed, zero failures.
- 2026-10-05: First integrated root gates passed: typecheck; formatter/check; lint (the baseline 15 warnings and 1,305 informational diagnostics); full tests with PostgreSQL/S3, 4,613 passed, 39 skipped, zero failures. Skips are 37 live Zerops cases and two SQLite concurrency cases. Final source-handoff correction and its post-fix verification remain open.
- 2026-10-05: Final source-handoff correction retains response cleanup through SDK token settlement using an invocation-local client and native abort listener. Its package checks passed (156 tests, zero failures); independent confirmation and repeated root gates are running. All other implementation and reference reviews passed.
- 2026-10-05: Final source review passed, including the queued-abort reproducer and listener cleanup. Repeated root gates passed: 4,615 tests passed, 39 expected skips, zero failures; typecheck, formatting and lint passed. WU5 and consumer references → `bbbb8c1`. Both disposable backend containers were removed. Sprint closed with C2 and live/operator-only evidence explicitly deferred above.
