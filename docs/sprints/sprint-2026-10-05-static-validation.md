# Sprint — static validation and parser simplification (2026-10-05)

**Goal.** Replace application-owned structural parsers with static schemas, remove duplicate validation, and replace the installation's Zerops JSON Schema interpreter with explicit schemas and an upstream drift check.

**Theme.** One readable definition per owned contract; parse once at each untrusted boundary and preserve existing behavior. Execution approved on 2026-10-05, including incremental commits and the proposed exceptions. The later platform-wide production review is separate.

## Refs re-verified at HEAD (2026-10-05)

Planning baseline was `5ddf08d` plus concurrent source-identity work. References were read in the working tree, not a clean checkout. Refresh HEAD and dirty paths before dispatch: the other sprint was finishing while this plan was written.

- ✔ `packages/installation-zerops/zerops/validate.ts:73` loads two local vendor documents and applies six duration corrections.
- ✔ `packages/provider-zerops/scripts/generate-zerops-types.ts:101` separately implements recursive JSON Schema-to-TypeScript generation.
- ⚠ `packages/provider-zerops/src/types.ts:80` derives public authoring types from generated types. Replacing them with the installation subset would narrow the public API.
- ✔ `packages/operations/src/operator-rpc.ts:118` wraps fixed manual parsers in a custom Standard Schema adapter.
- ✔ `packages/provider-zerops/src/source/validation.ts:22,129` implements key-set checks, including explicit-undefined rejection.
- ✔ `packages/control/src/control-rpc.ts:112` wraps manual predicates in `z.custom`.
- ✔ `packages/builder/shared/index.ts:117` manually parses fixed pairing-state variants.
- ⚠ `packages/iam/src/admin/app-schema.ts:67` and `packages/provider-zerops/src/manifest.ts:157` parse the same vocabulary with different tolerance.
- ✔ `package.json:10–32` defines typecheck, isolated interface tests, lint, formatting, release validation and local/browser integration commands.
- ⚠ At inspection, Control source identity, Cloudflare provider, runner and reference docs had concurrent edits. Confirm their owner's handoff before dispatching those territories.

Read each package's instructions before dispatch. Auth work must read [ADR-0022](../decisions/0022-the-proxy-is-the-only-enforcement-point.md) and its handoff amendment. Zerops work must read [platform facts](../reference/zerops-platform.md), ADR-0043 for descriptors, and applicable managed/source identity ADRs.

## Decisions and execution gate

Proposed defaults:

1. Owner-local Zod schemas; no universal validation package or new converter framework.
2. Static installation schemas plus a separately invoked upstream drift check. No Ajv or JSON Schema-to-Zod runtime conversion.
3. Keep generated public Zerops types initially. Their replacement is conditional WU09, not a prerequisite for removing the installation interpreter.
4. Keep `auth-core` dependency-free, `app` Standard Schema-neutral and the embedded `.toString()` approval parser self-contained unless explicitly approved otherwise. Do not duplicate their contracts to evade ownership.
5. Prefer the existing runtime Zod line if WU00 proves installed Standard Schema support. Any major upgrade needs a decision. Approve the exact version and runtime dependency additions to selected owner packages before implementation.
6. Four implementation agents maximum, one writer per territory, shared tree on the current branch. No new worktrees by default.
7. Three focused independent review batches, not a reviewer per WU. Local verification remains mandatory; production review comes later.

Before dispatch, the leader uses the question tool to confirm dependency changes, exceptions/WU09, the reduced review policy and the expanded territory ledger. This document alone authorizes no implementation, commits or production operations. An architecture change discovered later returns to the user; independent unblocked work can continue.

## Ownership and dispatch

The pinned [execution territory ledger](static-validation-territories.md) defines baseline allowlists and their exclusions.

Paths below are relative to the repository root. Package territories include tests, except explicit exclusions. The leader expands them into exact file allowlists and checks pairwise intersections before dispatch.

**Leader-only:** `package.json` files, `bun.lock`, export barrels, tool/TypeScript/CI configuration, generated artifacts, `CLAUDE.md` files and `docs/**`. Runtime entrypoints named `index.ts` are not automatically barrels. Pause a territory before leader edits there. Implementers report missing exports/dependencies rather than changing them.

**Shared seams:** WU00 establishes naming, error adaptation and version conventions. WU01 lands working shared schemas before dependent consumers start. Freeze interfaces after that. Consumers report a missing contract as `blocked`; they do not fork it locally. Intentionally different boundary acceptance remains explicit.

Each dispatch includes: allowed files/tests; contracts it consumes/exposes; exact narrow gate commands; applicable invariants; expected acceptance/normalization/error behavior. New files must stay inside its assigned territory. Cross-package integration tests belong to WU20.

Effort: **S** bounded family, **M** related boundaries, **L** broad package migration. These are relative sizes, not elapsed-time promises. L units may land sequential sub-batches with the same owner. Splitting one across agents requires a new disjoint file/test partition.

## Work units

Every row includes scope/problem, territory, dependency, verify-first probe and acceptance witness. All additionally follow the common completion contract below.

| WU / effort                           | Scope and exclusive write territory                                                                                                                                                              | Depends on                            | Verify first                                                                                | Acceptance / witness                                                                                                                             |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **WU00 / M — setup**                  | Leader: baseline, exact ledger, dependencies/exports, schema conventions, commands and exceptions.                                                                                               | Approval                              | Installed Zod support, package commands, caller/import graph and concurrent paths.          | A real Zod-backed procedure passes through Standard Schema; runtime/browser boundaries compile; approved seams frozen.                           |
| **WU01 / M — shared contracts**       | `packages/{operations-contract,control-contract,proxy-contract}/`: releases, proxy manifest/gates, builder receipt/discovery, list inputs. Embedded approval parser excluded.                    | WU00                                  | Compare callers, duplicate host rules, optional fields and serialization.                   | Consumers compile; positive/negative fixtures preserve output, ordering and error semantics.                                                     |
| **WU02 / L — Operations**             | `packages/operations/`: remove RPC adapter/manual inputs; catalog/release boundaries, ingest/detail/source maps, cursors, stored/queue data, config.                                             | WU01                                  | Operator tests and differing ingest/detail/upload/consumer tolerance.                       | RPC fixtures pass; partial telemetry still filters; original bytes, source-map fallback and persistent representations survive.                  |
| **WU03 / L — IAM**                    | `packages/iam/`: post-RPC duplicate removal; REST/RPC inputs, OIDC, signing keys, forms, device rows, stored grants/password parameters, env.                                                    | WU00                                  | Trace all typed use-case callers, including direct and closed REST calls; auth/admin tests. | Authorization/error order unchanged; failed proof still consumes code; signature precedes trusted claims; fail-closed and entrypoint tests pass. |
| **WU04 / M — auth clients/proxy**     | `packages/{auth,jwks,proxy-core,proxy}/`: response schemas, public JWKs, forwarded-header shape and env. `auth-core` read-only.                                                                  | WU01                                  | SDK vs proxy tolerance and denial/outage tests.                                             | Distinct acceptance retained; no second gate; malformed JWKS rejected; safe failures.                                                            |
| **WU05 / L — Control**                | `packages/control/`: envelope/JSON, jobs/logs, stored GitHub states, upstream/source/webhook input, config and scripts. Embedded approval code excluded.                                         | WU01; source-identity handoff         | Refresh source/lifecycle baseline and its tests.                                            | API/storage differences, commit identity, revisions, errors and queue variants preserved.                                                        |
| **WU06 / L — source wire protocol**   | `packages/provider-zerops/src/source/` and new tests below it. Root provider tests are WU07-owned but may be run read-only.                                                                      | WU00                                  | Existing source/credential fixtures, canonical bytes and explicit undefined.                | Supported versions, strict keys, safe errors and credential bytes pass; redundant structural helper layer removed.                               |
| **WU07 / L — Zerops provider**        | `packages/provider-zerops/` except WU06/WU09 and leader-only files: manifest, codecs, descriptor, namespaces, managed protocol, API and options.                                                 | WU01, WU06                            | Platform facts, descriptor/managed ADRs; manifest/codec/API tests.                          | Legacy fixtures, exact hashes/omission, descriptor bytes, CAS and foreign-reference rules pass; public surface preserved.                        |
| **WU08 / M — Zerops installation**    | `packages/installation-zerops/`: static YAML schemas, duration rules, upstream drift script, options and `gh` outputs.                                                                           | WU00                                  | Existing schema tests, generated artifacts and service-specific negative cases.             | Artifacts pass; invalid profiles/conditions/keys fail; offline drift fixtures pass; interpreter removed after equivalent witnesses.              |
| **WU09 / M — public type generation** | Conditional: `provider-zerops/scripts/generate-zerops-types.ts`, `src/types.ts`, new authoring schema files. Generated output remains leader-owned. These paths are reserved even when deferred. | Explicit surface decision; WU07, WU08 | Enumerate exported authoring API and consumers beyond installation.                         | Public supported surface/type tests retained; generator and correction layers removed only with complete replacement.                            |
| **WU10 / L — Cloudflare/runners**     | `packages/{provider-cloudflare,runner-container,runner-cloudflare}/`: codecs, job/report, outcome/health/status/logs/backstop, config.                                                           | WU01; source-identity handoff         | Worker/container caller chain and exact-source tests.                                       | Parsed jobs consumed; malformed status/logs handled; immutable checkout and Worker/image admission pass.                                         |
| **WU11 / M — GitHub/source service**  | `packages/{github-app,source-zerops}/`: identity/installation/token/manifest APIs, metadata and source config.                                                                                   | WU06                                  | API tolerance/redaction and source fixtures.                                                | Identity association and filtering preserved; credential-slot config rejected when malformed; source consumers match WU06.                       |
| **WU12 / M — other installation**     | `packages/{installation-cloudflare,installation-init}/`: CF responses, resumed credentials, auth/email settings, protection output and config.                                                   | WU00                                  | Best-effort accounts/zones and all-or-none resume tests.                                    | Same fallback and redaction; partial bundles rejected; sidecar behavior preserved.                                                               |
| **WU13 / L — Builder**                | `packages/builder/`: shared DTO/state, daemon/CLI/UI boundaries, persistence and config.                                                                                                         | WU01, WU14                            | Package test runner, old persistence and CLI/UI tolerance.                                  | Fixed state unions, shared matching contracts, supported recovery and retained draft extensions.                                                 |
| **WU14 / M — Canvas/annotations**     | `packages/{canvas-kernel,annotations}/`: frames, sessions/drafts/feedback, preview/upload responses. Daemon-kit seams go to leader.                                                              | WU00                                  | Isolated interface tests and legacy recovery fixtures.                                      | Browser/daemon frames and migration pass; annotations retained; DOM suites isolated.                                                             |
| **WU15 / M — consoles**               | `packages/{dashboard,iam-ui,operations-ui}/`: manifest editors, grants/scopes/share links, alerts and activity projections.                                                                      | WU01, WU02, WU03, WU07, WU10          | Existing forms and actual request contracts.                                                | Field errors retained; requests match server; provider extensions survive edits.                                                                 |
| **WU16 / M — CLI/examples**           | `packages/cli/`, `examples/`: JSON/API responses, collected options, request/env/DB parsing.                                                                                                     | WU04, WU07, WU10                      | Routing/type tests and executable config branding.                                          | Same flags/precedence; executable identities retained; both provider examples compile.                                                           |
| **WU17 / M — local stack**            | `packages/local-stack/`: emulator requests/snapshots, fixtures, smoke response parsing, machine-key/config.                                                                                      | WU02, WU03, WU05, WU07, WU11          | Legacy snapshot tests and integration prerequisites.                                        | Snapshot/rejection tests pass; fixture identities retained; actual integration evidence recorded.                                                |
| **WU18 / M — ports/email**            | `packages/{platform,platform-node,email}/`: config, DB metadata/JSON, migration-plan inputs, Resend/message shapes.                                                                              | WU00                                  | Relevant tests and backend skips; assess benefit before replacing tiny predicates.          | Migration identities/locks and DB numeric semantics retained; safe email errors; backend skips reported honestly.                                |
| **WU19 / M — release tooling**        | `scripts/` except leader config: package/release manifests and npm JSON output.                                                                                                                  | WU00                                  | `release:validate`; nested exports/bin and dependency fixtures.                             | Metadata/extensions preserved; malformed data rejected; validate passes without publishing.                                                      |
| **WU20 / M — integration**            | Leader: cross-package tests, helpers audit, manifests/barrels, docs, ledger and final gates. Agents clean their own territories.                                                                 | Selected WUs and reviews              | Compare integrated diff with ledger and longlist.                                           | No unowned gap; exceptions documented; gates recorded; production-review handoff complete.                                                       |

## Longlist coverage

Numbers refer to the 71-item proposal. The WU scopes above are self-contained; ignored audit files are optional discovery material, not an execution dependency.

| Longlist items                     | Owner                                                                              |
| ---------------------------------- | ---------------------------------------------------------------------------------- |
| 1–3                                | WU08                                                                               |
| 4–5                                | WU09, conditional                                                                  |
| 6–7                                | WU02                                                                               |
| 8–10                               | WU03                                                                               |
| 11                                 | WU05                                                                               |
| 12–15                              | WU06                                                                               |
| 16                                 | WU01 definitions; WU02/WU05 consumers                                              |
| 17–18, 20–21                       | WU07                                                                               |
| 19                                 | WU07/WU10 per provider                                                             |
| 22–23                              | WU10                                                                               |
| 24–25                              | WU02/WU05/WU10 in their territories                                                |
| 26                                 | WU03/WU07/WU10 boundary adapters; shared auth-core ownership change needs approval |
| 27                                 | WU01                                                                               |
| 28–29; public JWKS part of 31      | WU04                                                                               |
| 30; private signing part of 31; 33 | WU03                                                                               |
| 32, 34                             | Architectural exceptions by default                                                |
| 35                                 | WU07                                                                               |
| 36–37                              | WU11                                                                               |
| 38                                 | WU05/WU11                                                                          |
| 39–40                              | WU12; WU08 owns Zerops upgrade output                                              |
| 41                                 | WU18                                                                               |
| 42                                 | WU13                                                                               |
| 43                                 | WU01 definitions; WU13 consumers                                                   |
| 44                                 | Embedded-parser exception by default                                               |
| 45–46                              | WU13                                                                               |
| 47–49                              | WU14; WU13 owns Builder persistence                                                |
| 50–51                              | WU15                                                                               |
| 52–54                              | WU02                                                                               |
| 55                                 | WU03                                                                               |
| 56                                 | WU05                                                                               |
| 57                                 | WU02 and owner-local row decoding                                                  |
| 58–59                              | Each package WU owns its config/options; WU00 sets conventions                     |
| 60                                 | WU12                                                                               |
| 61                                 | WU16                                                                               |
| 62–63                              | WU17                                                                               |
| 64                                 | WU19                                                                               |
| 65                                 | WU18                                                                               |
| 66                                 | WU16                                                                               |
| 67–71                              | All implementers; WU00/WU20 integration ownership                                  |

WU00 persists the exact file ledger before dispatch. Each inventoried candidate ends as migrated, retained with a reason, or explicitly deferred. The earlier local audit's Ajv recommendation is superseded for installation validation.

## Sequencing

Use a dependency-driven queue with **at most four implementers**, rather than waiting for every unit at a wave barrier.

1. **Wave 0:** leader WU00, then WU01. Land working shared schemas, not executable throwing stubs.
2. **First ready set:** WU02 Operations, WU03 IAM, WU06 source protocol, WU14 Canvas. These establish the worked pattern and unlock consumers.
3. **Rolling queue:** prioritize WU07, WU11, WU13 when ready; fill slots with WU04, WU08, WU12, WU18, WU19. WU05/WU10 wait for source-identity ownership handoff.
4. **Consumers:** WU15, WU16, WU17 after their prerequisites. WU09 only if separately approved.
5. **Close:** WU20, remaining review/fixes and final verification; hand off to production review.

Critical serial chains: WU06 → WU07 → WU15/WU16/WU17 and WU14 → WU13. Start these prerequisites early. A blocked architecture decision does not stop unrelated work. Splitting an oversized WU requires a fresh disjoint partition, not another writer in its package.

## Reduced review policy

The leader checks scope/diff/evidence per unit. No separate spec-review and reviewer per routine WU. Instead use **three independent focused batch reviews**, one reviewer each, on frozen commit ranges:

| Review                          | Scope                                        | Focus                                                                 |
| ------------------------------- | -------------------------------------------- | --------------------------------------------------------------------- |
| **R1 — wire compatibility**     | WU01–WU04, WU06                              | Acceptance/output/errors, auth order, shared seams                    |
| **R2 — persistence/deployment** | WU05, WU07–WU12, WU18; WU09 only if selected | Bytes/hashes, secrets, source identity, API tolerance, public surface |
| **R3 — consumers/integration**  | WU13–WU17, WU19–WU20                         | Recovery, schema reuse, parsed output use, dependencies and omissions |

Unrelated work continues during reviews. Each reviewer gets the contract, frozen diff and witnesses, not a request for a whole-repo audit. Findings go through one fix round with the original owner; unresolved design questions return to the user. No weakened tests or hidden deferrals.

Leader-verified WUs may be committed before their batch review. Review completion is tracked separately. Subsequent material changes to a reviewed schema receive a focused delta review. The later production review does not excuse failing local compatibility tests.

## Completion and verification

Every implementer must:

1. Read owners/callers and run the recorded narrow baseline probe before edits.
2. Preserve strict/strip/passthrough, absence/undefined/null, defaults, filtering, normalization and error categories.
3. Use parsed output inward; do not rebuild a generic manual-validator layer around `safeParse`.
4. Retain crypto, authorization/gates, identity/digest checks, network admission and state transitions in their owners.
5. Test observable acceptance/rejection **and output** for non-trivial migrations; compare exact bytes/digests for persisted contracts. Expectations must not be generated by the new parser.
6. Run narrow typecheck, relevant lint/format and meaningful tests, with existing isolated DOM tooling.
7. Return files, empty `outsideTerritory`, exact commands/results, coverage limits, deviations, deletion candidates and blockers. No commits, pushes, dependency installation, stash/revert or gate changes by agents.

The leader reruns a meaningful integrated gate before an explicit-path atomic commit. Match current history; do not commit partial/blocked/unverified work. Full gates run once after integration, then repeat only as justified by fixes:

```bash
cpu-lease run -n 4 -- bun run typecheck
cpu-lease run -n 2 -- bun run lint
cpu-lease run -n 2 -- bun run format:check
cpu-lease run -n 4 -- bun run test
cpu-lease run -n 2 -- bun run release:validate --tag=v0.0.4
```

Serialize full gates. CPU-bound package checks also lease suitable capacity. Format only the active territory during implementation.

Cross-plane witnesses cover IAM requests/use cases, proxy/IAM responses, source client/service, Worker/container, Operations reconciliation and Builder CLI/UI/daemon. Run local smoke and affected browser scenarios on a dedicated test stack after verifying commands and prerequisites. `local:smoke` is disruptive; do not use a shared active stack. Supply documented Postgres/S3 backends for affected persistence tests before claiming those paths verified; skips remain explicit limitations.

The upstream check needs offline unchanged/changed fixtures; network failure is distinct from drift. No live Zerops resource creation or production operations are authorized here.

## Out of scope and deferrals

- Auth model, provisioning order, source identity, SQL migrations and data model changes.
- Full copies of every external API; validate consumed shapes with existing forward tolerance.
- WU09 until the public supported type surface is approved.
- Runtime Zod in `auth-core`, mandatory Zod in `app`, embedded approval-page bundling until approved. Keep these longlist items visible as exceptions.
- Mechanical conversion of tiny native predicates without a simplification benefit; record reasons to retain them.
- New global config/schema frameworks and unrelated cleanup.
- Push, deployment, publication and the platform-wide production review.

## Run log

- Concurrent work: commits `76d42cb`, `dab5b73`, `4ea388d` removed self-asserting/vacuous tests while this sprint ran. They are separate work, preserved and excluded from this migration's change accounting. Integrated checks include their resulting test suite.
- R3 WU15 passed; WU19 found own `__proto__` key loss in package metadata and export traversal. One corrective round assigned to preserve all own JSON keys and add staging/target witnesses. CLI/example dependency integrated centrally; WU16 verification next.

- WU05 `fafb3c2`: leader 830 Control tests pass, 2 SQLite-only CAS skips with Postgres enabled. WU10 `090b30a`: leader 253 Cloudflare/runner tests pass; runner Docker build and dry-run smoke pass. R2 is closed with no unresolved findings across all selected delivery/persistence units.
- WU15 `90bfe60`: leader 83 console tests pass; form parsing preserves field errors and opaque provider extensions. Removed unused Operations UI Zod. WU19 `52b7f4d`: leader 85 release-tooling tests pass; metadata/registry schemas, native publication/domain policy retained. No publication executed. R3 remaining slices pending.

- WU18 `c3591f6`: leader reran 223 tests with real Postgres/S3, no skips. Resend response schemas migrated; driver/migration/runtime identity and typed domain validators retained, unused Platform Node dependency removed. R3 coverage preparation accounted for all 205 original primary/supplemental candidates at `1ccc6cc` (122 completed, 75 pending, 8 architectural exceptions); no missed completed-unit boundary or newly dead helper found.

- R1 completed with no unresolved findings across WU01–WU04/WU06, including independent frozen-snapshot tests and differential probes. R2 WU07/WU08 slice found no issue; further R2 units pending.
- WU11 `0bdeb39`: leader reran 251 GitHub/source tests; static response projections preserve permissions, association, metadata tolerance and secret-safe errors. WU12 `cad9752`: leader reran 94 installation tests; resumed credentials and CF/protection projections migrated, unused narrowing module removed. Scalar config/domain checks retained in both.

Retained boundary dispositions are recorded in the [exception ledger](static-validation-exceptions.md); remaining units add their dispositions when integrated.

- WU02 committed `32b7c2c`; leader reran 167 Operations tests with Postgres/S3, no skips. WU04 committed `a22dc0c`; leader reran 439 auth/JWKS/proxy tests, no skips; unused proxy Zod dependency removed. Both retain domain/security/scalar checks; R1 final slices pending.
- WU07 committed `342d6b6`; leader reran provider tests (745 pass, 37 live skips), typecheck; removed obsolete source structural helpers after namespace migration. Runtime alias-preserving refinements, YAML AST/source checks and canonical/hash/domain checks remain. R2 first slice includes WU07/WU08.
- WU13 committed `a07e461`; leader reran 180 isolated Builder tests and typecheck. WU14 review fixes committed `a2769b4`, regression tests verified before/after. R3 confirmed both fixes and no Builder findings after 960 differential comparisons; remaining consumer units pending.

- WU08 integrated: replaced generic JSON Schema interpretation with static installation schemas and explicit duration string fields; added read-only `check:schemas` with offline drift/error fixtures. Leader reran 455 tests, package typecheck, lint and generation check (11 unchanged artifacts). Interpreter keyword tests were replaced with domain rejection witnesses; diagnostics now correctly name the supported installation subset. Full provider type catalog and inline import `zeropsYaml` remain outside this installation schema. Initial verification attempts timed out waiting for CPU leases; subsequent leased runs passed.

- WU02 decision: user explicitly approved retaining a small Operations-local Standard Schema diagnostic adapter to preserve the existing HTTP 400/type/message/issues contract. Structural validation remains static Zod; the four exact compatibility assertions stay intact. This overrides the plan's unconditional removal of that error adapter.

- R3 first slice found two WU14 recovery regressions: exact-length saved-response tuples drop legacy trailing data during hydration; one malformed remote annotation drops its entire otherwise valid submission. Queue one WU14 fix round with carry→hydrate and read→append→reload witnesses before review completion. Both are pending, not accepted deferrals.

- WU03 integrated: IAM-owned HTTP/REST/OIDC/JWK/password/persisted/config-list schemas and duplicate admin parsing removal. Leader ran IAM suite with dedicated Postgres: 522 pass, no skips/failures; typecheck and scoped lint/format pass. Auth-core-owned device/access parsers, proof/state/domain checks, scalar config, numeric conversion and audit payloads remain intentional exceptions. R1 first slice reviewed frozen WU01/WU06 with no findings (107 tests and 213 differential release probes); remaining R1 units pending.

- WU06 integrated: static strict source protocol schemas, secret-safe diagnostics and 55 additional compatibility cases including exact credential digest. Leader reran 322 wire/client/service tests successfully. Namespace compatibility helpers remain until WU07 migrates their callers; R1 pending.
- WU14 integrated: annotation/session/frame/response schemas, legacy recovery and per-entry filtering. Added annotations schema subpath and Canvas client schema exports. Leader reran isolated interface suite (321 pass, no skips), both package typechecks and scoped lint/format. Identity-sensitive compiler/runtime checks and opaque host response storage retained deliberately; R3 pending.

- WU01 integrated: shared release, proxy and builder/list schemas; public barrels switched and unused proxy string readers removed. Leader verification: 83 tests pass with Postgres enabled (no skips), three package typechecks pass, scoped lint/format pass. Existing receipt/release serialization and embedded approval witnesses remain green. R1 batch review pending.

- User approved temporarily stopping `fabrika-builder-spike` for final smoke/browser tests, preserving its data and restarting the original containers afterwards. No stack has been stopped yet.

- Integration preparation: created dedicated `fabrika-validation-pg` (loopback port 55439) and `fabrika-validation-s3` (59009) test containers using the repository's documented fixtures; both healthy and SQL/S3 probe tests pass. Existing test DB on 55433 did not accept the documented fixture credentials and was left untouched. An existing stack occupies browser ports 18080/18081; do not stop it or run disruptive smoke against it. Full typecheck during active edits observed unfinished source exports and pending annotation schema exports, so it is not a baseline or final result; rerun after units settle.

- WU00: Standard Schema dispatch witness passed (17 tests / 39 assertions). Installed Zod 3.25.76 exposes Standard Schema. Root lint passed with existing warnings/informational diagnostics. Release validation requires an explicit tag off a release commit; `--tag=v0.0.4` passed for all 28 public packages. Dependency manifests are reserved centrally; final integration removes any dependency unused by a retained boundary. WU01/WU03/WU06/WU14 dispatched into disjoint territories.

- 2026-10-05: User approved execution and incremental commits. Refreshed baseline `ab534ea`; source-identity work is committed and archived, with no remaining source edits. Use Zod `^3.25.76` (existing installed major, Standard Schema support confirmed). Keep WU09 and the three architectural exceptions deferred as proposed. WU01 may run alongside independent WU03/WU06/WU14 after setup; dependent consumers wait for its completion.

- 2026-10-05: Prepared proposal: 21 WUs including setup/integration, WU09 conditional; four implementers maximum and three focused independent review batches. No implementation dispatched. Refresh the concurrent source-identity handoff before execution.
