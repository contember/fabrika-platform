> **OUTCOME — shipped 2026-09-21.** Shared Operations input definitions and bound-source provider contracts are in place. All sixteen targets are decomposed along existing capabilities; the largest extracted module is 783 lines. Each unit passed independent review and leader-run verification. Commit map: WU0 → `7f6b674`, WU1 → `2b93b8d`, WU2 → `d7fcffb`, WU3 → `aab0c1f`, WU4 → `17ad175`, WU5 → `48a0de2`, WU6 → `d859d7f`, WU7 → `3d474f8`, WU8 → `5549a43`. Final gates: full typecheck, formatter, lint and release validation pass; root tests report **3,425 pass, 203 skip, zero failures**. Lint retains 17 baseline warnings and reports 1,223 informational diagnostics. Builder/CLI separation remains deferred by user choice. No live Postgres/S3/Zerops or browser verification was performed; no push or deployment occurred. No backlog items were consumed.

# Sprint — Simplify existing boundaries (2026-09-21)

**Goal.** Remove duplicate input/provider contracts and split sixteen large source files along existing responsibilities without changing observable behavior.

**Theme.** Make the current platform easier to change. Preserve deployment, authentication, persistence, public exports and transport contracts.

## Refs re-verified at HEAD (2026-09-21)

- ✔ Baseline `9917992`: typecheck passes; root tests report 3,421 pass, 203 skip, zero failures; lint exits zero with 17 warnings and 1,231 informational diagnostics.
- ✔ Operations defines health and issue-mutation payload rules twice: `packages/operations/src/operator-api.ts:985,1067` and `packages/operations/src/operator-rpc.ts:243,287`.
- ✔ REST mutation parsing is lazy after object authorization; RPC schemas parse before the shared use case. Preserve that distinction.
- ✔ Bound-source methods are independently declared in `packages/control/src/run-lifecycle.ts:61` and `packages/provider-zerops/src/control.ts:134`, outside `ControlProvider`.
- ✔ Sixteen tracked non-test TS/TSX files exceed 800 physical lines. Large files often contain several already separate capabilities, not one huge function.
- ✔ Builder existed before its merge. The user explicitly deferred CLI separation; product removal is not part of this work.

## Work units

| Unit                  | Effort | Exclusive write territory                                                                                                 | Acceptance / witness                                                                                                                            |
| --------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| WU0 — Provider seam   | S      | Shared provider control contract/barrel; Control lifecycle and Zerops control adapter; their narrow tests                 | One declaration of bound-source inputs/capability; existing exact-binding, isolation and refusal tests; package typechecks                      |
| WU1 — Operations      | M      | `packages/operations/`                                                                                                    | Shared payload rules drive both adapters, transport failure shapes/order preserved; focused REST/RPC tests; repositories and operator API split |
| WU2 — Control         | M      | Control DB, GitHub store, source connection, registry and their extracted modules; relevant tests; excludes WU0 lifecycle | Original public paths remain; SQL/atomicity/CAS/audit unchanged; existing package tests                                                         |
| WU3 — IAM             | M      | `packages/iam/`                                                                                                           | DB, admin handlers and auth routes split; authentication/admission/authorization ordering and public paths preserved; existing package tests    |
| WU4 — Zerops provider | M      | Zerops API, namespace and source modules plus extracted modules; relevant tests; excludes WU0 control adapter             | Transport bounds, retry/error semantics, source validation and namespace recovery preserved; provider tests                                     |
| WU5 — GitHub client   | S      | `packages/github-app/`                                                                                                    | Extract crypto/parsing/transport responsibilities; retain exports, cancellation, timeout and credential redaction; client tests                 |
| WU6 — Dashboard       | S      | `packages/dashboard/`                                                                                                     | Extract app-detail sections/components without changing form state, requests or accessibility; typecheck and existing tests                     |
| WU7 — Installer       | M      | `packages/installation-zerops/`                                                                                           | Extract install phases while retaining operation order, generated artifacts, flags, prompts and recovery; installation tests                    |
| WU8 — Local emulator  | S      | `packages/local-stack/`                                                                                                   | Extract emulator protocol/state helpers; same routes, state and failure behavior; emulator/platform-fact tests                                  |

**Verify first for every unit.** Read its package instructions, original source and callers; identify existing complete operations and public exports. Run the narrow pre-change check when necessary to distinguish a baseline issue. Read ADR-0022 for auth and the Zerops platform reference for provider/installation work.

### Exact decomposition targets

- Operations: `src/repositories.ts`, `src/operator-api.ts`.
- Control: `src/db.ts`, `src/github-connection-store.ts`, `src/source-connection.ts`, `src/api/registry.ts`.
- IAM: `src/db.ts`, `src/admin/handlers.ts`, `src/auth/routes.ts`.
- Zerops provider: `src/api.ts`, `src/namespace.ts`, `src/source.ts`.
- GitHub client: `src/index.ts`.
- Dashboard: `src/routes/apps/detail.tsx`.
- Zerops installer: `src/install.ts`.
- Local stack: `src/zerops-emulator.ts`.

Extraction follows existing capabilities, not arbitrary line chunks. Avoid replacing a large file with another equally broad implementation file. Keep helpers/types near the operation that owns them and retain stable entrypoints where consumers require them. New modules should not import their own facade and create cycles.

## Out of scope

- Builder/CLI separation, removal of product features, new dependencies, new plugin or validation frameworks.
- Removing REST endpoints, changing URL/query coercion, error payloads, authorization ordering, SQL, migrations or provider wire formats.
- Deploying, publishing, pushing, and obtaining live credentials.
- Unrelated findings from the preceding audit.

## Decisions

- User approved all sixteen targets, independent implementation/review agents and atomic commits on the existing branch.
- Operations shares input definitions, not a new endpoint-generation framework. Reuse existing parser/Standard Schema support without introducing a dependency. Identify genuinely equivalent payload rules; keep transport extraction and differing query semantics explicit.
- Preserve public APIs and package ownership. WU0 consolidates the existing optional capability rather than adding a new runtime extension mechanism.
- Ignore local `.smellhunt/` audit artifacts.

## Sequencing

WU0 establishes and freezes the shared seam before Control and the Zerops provider change. Independent Operations, IAM and GitHub-client units may run alongside it. Remaining independent units fill available slots, with at most four implementation agents. Each unit receives an independent diff review and leader-run verification before its explicit-path commit. Review fixes return to the original implementer once; architecture blockers require a user decision.

Final integrated gates: formatter, typecheck, lint, root test command and release validation. Full CPU-heavy checks are serialized under `cpu-lease`. Backend skips and any baseline formatting/lint failures are recorded rather than suppressed.

## Run log

- 2026-09-21: Scope approved. `.smellhunt/` added to `.gitignore`; WU0 dispatched. Baseline audit artifacts remain local and ignored.
- WU0: `7f6b674` centralizes optional bound-source methods and inputs. Independent review clean; leader reran three package typechecks and 68 lifecycle/provider tests (312 assertions), all passing. Existing Zerops bound-input names remain aliases. WU4 will alias the remaining provider-internal binding shape to the shared declaration.
- Release validation: `bun run release:validate --tag=v0.0.4` passes for 28 public packages. An explicit tag is required on this untagged working commit; no tag was created and nothing was published. A clean HEAD archive also passes the formatter baseline check.
- WU3: `aab0c1f` splits IAM's three targets into existing repository, admin and auth capabilities. Independent review verified all 157 original declarations unchanged apart from exports/comments and all original exports retained. Leader typecheck and 435 tests pass; 53 backend-dependent tests skip. Largest extracted module is 309 lines. Four inherited optional-chain lint warnings remain; no rules were disabled.
- WU6: `d859d7f` extracts five application-detail sections outside router discovery. Independent review confirmed all 15 moved functions and section markup/state ownership preserved. Leader typecheck (including route generation) and 47 tests pass; no browser interaction was run.
- WU5: `48a0de2` splits the GitHub client into signing, transport, validation and manifest modules. Independent review checked signing-clock asynchronous timing and all root exports. Leader typecheck, 33 tests and scoped lint/format pass; no live GitHub requests were made.
- WU1: `2b93b8d` centralizes shared operator payload rules, preserves REST/RPC differences explicitly, and decomposes repositories/operator handlers. Independent review verified all 52 repository declarations and new transport behavior tests. Leader typecheck and 128 tests pass, with five Postgres/S3-dependent skips; scoped lint has no warnings/errors. Existing authorization checks and assertions remain intact.
- WU2: `d7fcffb` decomposes Control's four targets. Independent review verified 231 unchanged declarations and 97 preserved exports. Leader typecheck and 502 tests pass, with 38 Postgres-dependent skips; scoped lint/format pass.
- WU4: `17ad175` decomposes Zerops API, namespace and source modules and aliases the internal binding type. Independent review verified 281 unchanged declarations and 161 preserved exports. Leader typecheck and 357 tests pass, with 37 live-Zerops skips; scoped lint/format pass.
- WU8: `5549a43` extracts emulator models, parsers and protocol helpers. Independent review confirmed the class/factory are byte-identical and 41 extracted declarations preserved. Leader typecheck, 87 tests and scoped lint/format pass.
- WU7: `3d474f8` extracts installer environment, project and provisioning responsibilities. Independent review confirmed 36 declarations and eight original exports preserved. Leader typecheck, 386 tests and scoped lint/format pass.
- Final integrated gates: `cpu-lease run -n 4` serialized `bun run typecheck`, `bun run test`, `bun run lint`, and `bun run release:validate --tag=v0.0.4`; all exit zero. Main tests: 3,017 pass / 203 skip; agent interfaces: 310 pass; builder: 98 pass. Full `bun run format` also passes. Skipped suites retain the same backend/live-account requirements as the baseline.
