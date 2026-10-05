# Sprint — source identity and bounded provider cleanup (2026-10-05)

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

### WU4 — Reuse decoded Zerops registration values (M)

- **Problem.** Adjacent codec cycles obscure validated data flow.
- **Verify first.** Establish normalization/codec fixed points, optional-field ownership, hashes and alias detachment through public entrypoints.
- **Scope.** Use the shared decoder; retain typed canonical parts inside one invocation. Keep independent entrypoint/recovery validation. Use native cloning only where it preserves the old artifact detachment.
- **Acceptance / witness.** Canonical envelopes, descriptor/manifest identity, hook isolation, exact errors and no-effect refusal remain equivalent. A failed codec fixed-point witness blocks removal of that cycle.
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
