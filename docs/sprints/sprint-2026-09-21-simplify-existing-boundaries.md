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

WU0 establishes and freezes the shared seam. WU1–WU4 then run in parallel, at most four implementation agents. WU5–WU8 form the next independent wave. Each unit receives an independent diff review and leader-run verification before its explicit-path commit. Review fixes return to the original implementer once; architecture blockers require a user decision.

Final integrated gates: formatter, typecheck, lint, root test command and release validation. Full CPU-heavy checks are serialized under `cpu-lease`. Backend skips and any baseline formatting/lint failures are recorded rather than suppressed.

## Run log

- 2026-09-21: Scope approved. `.smellhunt/` added to `.gitignore`; WU0 dispatched. Baseline audit artifacts remain local and ignored.
