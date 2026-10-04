# OUTCOME — Platform simplification (2026-10-04)

Delivered fourteen implementation units through separate agents, independent reviews, coordinator verification and atomic commits. Complete product scope, including Operations Console, is retained. WU14 and conditional extractions were deferred where a smaller equivalent implementation was not established.

## Commit map

| Unit | Commit    | Result                                                                                             |
| ---- | --------- | -------------------------------------------------------------------------------------------------- |
| WU1  | `a30a04c` | Remove unused private Control APIs and migrate behavioral witnesses                                |
| WU2  | `823cb86` | Own unexpected runner failures and await child/pump cleanup                                        |
| WU3  | `2f4911e` | Serialize/coalesce relay log snapshots and join final persistence                                  |
| WU4  | `a0045c2` | Reuse validated manifests and parsed descriptor setup selection                                    |
| WU5  | `4e3c4f3` | Persist App credentials before creation acknowledgement                                            |
| WU6  | `7928e88` | Correct bootstrap recovery guidance and remove the unused prompt                                   |
| WU7  | `b175d7f` | Remove false silence alarms; preserve real alert provenance across unavailable/legacy stale states |
| WU8  | `3dbbde4` | Share existing console widgets without changing interfaces or rich icons                           |
| WU9  | `c9eb7f7` | Decode/settle corrupt queue deliveries independently; retain legacy adapters                       |
| WU10 | `48c57e6` | Validate stored release payloads while preserving historical hashes/errors                         |
| WU11 | `5628c58` | Repair terminal releases from frozen context with ownership and CAS fencing                        |
| WU12 | `1532ae7` | Share supported EC key-set parsing across existing transports                                      |
| WU13 | `9b987c7` | Share provider-local Cloudflare config loading                                                     |
| WU15 | `62ffd26` | Share native Zerops upload destination policy without merging transports                           |

## Verification and measured changes

- Final `bun run test`, with real PostgreSQL enabled: **4,395 passed, 48 skipped, zero failures**. The platform phase passed 3,921, isolated DOM suites passed 310, and the isolated builder command passed 164.
- Skips: eight S3 adapter tests, one Operations S3 integration test, 37 live Zerops platform-fact cases, and two PostgreSQL-only concurrency cases in the SQLite variant. The corresponding PostgreSQL concurrency cases passed.
- Root typecheck, formatter, format check and lint passed. Lint retains 15 warnings and 1,305 informational findings; no errors. Generated Zerops artifact check and release validation for 28 public packages at `v0.0.4` passed.
- Dashboard production build passed. GitHub custody tests use the real loopback server and filesystem with delayed/failing persistence; GitHub conversion itself is simulated.
- Terminal-repair retention witness on SQLite and real PostgreSQL: 2,500 clean terminal rows plus one pending projection use **32 database calls**, apply the pending projection, and leave no leases. Both variants exceeded the simulated 10,000-query budget before the fix. This is a counted-operation regression witness, not a benchmark or an actual D1 limit test.
- Relative to initial `16fefac`, production TS/TSX/CSS/SQL has **745 added / 677 removed, net +68 lines** across 49 files. Cleanup/shared-code units remove a net 302 lines; reliability repairs add a net 370. Tests add a net 3,175 lines across 34 files. Package metadata and docs are outside these source counts.
- No live Cloudflare/D1/R2, live Zerops, live GitHub creation, real S3, browser interaction, publication, or deployment verification ran. No push or deployment occurred.

## Deferrals

- Full missing-context release recovery and credential-expiry semantics require approved durable-intent/protocol ownership → [backlog 95](../backlog/95-close-release-recovery-without-frozen-context.md).
- Settings sharing was deferred because preserving exact write order requires additional lookup/reordering machinery. Source-binding map removal and composite cleanup extraction were deferred because their overlap/cancellation contracts prevent the proposed smaller equivalent implementation.
- Notification outbox consolidation was deferred because reusing enqueue would change concurrent channel/source configuration behavior.
- Native release artifact handoff saves repeated pack/smoke work but adds workflow lines and artifact upload/download/checksum failure states. WU14 is deferred under its smaller-and-provable gate.
- Terminal discovery remains a complete captured-range scan with bounded pages, not a universal invocation-work bound. Retained history and repair volume still determine total work.
- Proxy/IAM operational policy changes and published plan metadata removal remain outside the approved batch.

## Original sprint plan

**Goal.** Reduce duplicate work and accidental failure states while preserving the complete platform product, including Operations Console.

**Theme.** Remove unused private APIs, reuse existing mechanisms, and restore completion ownership inside current modules. Each independent unit receives review, focused verification, and an atomic commit.

## Refs re-verified at initial HEAD `16fefac`

- ✔ The queue claims atomically before decoding a whole batch, so corrupt records can lose their delivery identity — `packages/platform-node/src/job-queue-postgres.ts:123–137`.
- ✔ Runner execution has no outer unexpected-failure boundary — `packages/runner-container/src/runner.ts:353`.
- ✔ Relay flushes can overlap and overwrite a later complete snapshot — `packages/runner-cloudflare/src/relay.ts:106–116,132–138`.
- ✔ Error silence produces `stale_processing` without a heartbeat contract — `packages/operations/src/health.ts:247–269`.
- ✔ Release replay selects dirty rows only; terminal status can precede projection persistence — `packages/control/src/run-lifecycle.ts:541–544` and `packages/control/src/operations-releases.ts`.
- ✔ Six synchronous codec consumers immediately parse already validated manifests again — `packages/provider-zerops/src/control.ts`, `src/namespace/claims.ts`, and `packages/control/src/node/zerops-proxy.ts`.
- ⚠ An absent release context cannot be safely reconstructed from today's registry. This sprint repairs only existing frozen contexts.
- ⚠ `dependsOn`, injectable queue adapters, and published parsers are public contracts. Internal non-use is insufficient evidence for removal.

## Work units

Each unit first traces callers and existing tests. Shared-tree write territories are disjoint, including tests. CPU-heavy checks use `cpu-lease`.

| Unit | Effort | Scope and touch points                                                                                                                | Acceptance / witness                                                                                                         |
| ---- | ------ | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| WU1  | M      | Control: remove private `getState`, state projection type, `beginAttempt`, unguarded namespace updater, and `refToEnv`; migrate tests | Expiry, redaction, malformed state, recovery, fenced namespace persistence/removal/races, including PostgreSQL               |
| WU2  | M      | `runner-container`: execution failure owner and native child/pump cleanup                                                             | Spawn/pipe/observer rejection reaches safe terminal status, closes logs, and does not release an active child                |
| WU3  | S      | `runner-cloudflare`: one serialized/coalescing log writer                                                                             | Delayed earlier writes cannot replace the final complete/empty snapshot; errors are observed; backstop remains               |
| WU4  | M      | `provider-zerops`, plus Control's namespace-proxy compiler: adjacent reparses and descriptor selection                                | Exact coordinate errors, original hashes/optional fields, all-setup validation and effect-boundary checks remain             |
| WU5  | S      | `installation-cloudflare`, shared helper tests: existing credential writer through `onCreated`                                        | Actual loopback acknowledgement waits for persistence; failed persistence does not report creation success                   |
| WU6  | M      | `installation-zerops`: partial-bootstrap guidance, unused prompt, common nonsecret settings                                           | Exact values and write order, pass-one/pass-two behavior, dry run, idempotence, and guards remain                            |
| WU7  | M      | Operations health/telemetry: remove unsupported silence diagnosis                                                                     | Quiet/empty sources do not generate false failures; real failures and recovery/history remain observable                     |
| WU8  | S      | IAM UI/dashboard: share existing modal, confirmation, and table implementations                                                       | Interfaces, icons, error/busy behavior, close behavior, accessibility and both typechecks remain                             |
| WU9  | M      | Platform-node raw claim, Operations node consumer: per-delivery decoding                                                              | Legacy API compatibility, corrupt/mixed batches, budgets, peer progress, valid exhausted archive-before-ack; real PostgreSQL |
| WU10 | M      | Operations release contract/parser and Control sender: structural boundary decoding                                                   | Invalid rows cannot override trusted envelope fields; serialization/hash/omission/error contracts remain                     |
| WU11 | M      | Control release repository/replay: bounded terminal discovery from existing frozen context                                            | CAS/fencing, one semantic revision, active invocation exclusion, stable historical observations, SQLite/PostgreSQL           |
| WU12 | S      | JWKS/auth/proxy-core: one supported key-set parser                                                                                    | Supported representations agree; transport, cache, audience and verification semantics remain                                |
| WU13 | S      | Cloudflare provider: repeated config loading                                                                                          | Existing public wrappers, path/cwd/injection/error behavior remain                                                           |
| WU14 | M      | Release workflow: consider same-run verified artifact handoff                                                                         | Real-tag identity, checksums, all validation/provenance/registry smoke retained; change only if smaller and provable         |
| WU15 | S      | Provider/source/installation: one native upload destination predicate                                                                 | Exact native URL grammar, distinct wire parser, fixed adapter errors, original PUT strings and cancellation remain           |

## Out of scope

- Product cuts, including advanced triage, source administration, placement presets, or any Operations capability.
- Proxy `ensure-current`/refresh policy, binary reuse, hot reload, and IAM rotation/atomic reconcile contracts.
- Removing public plan metadata or npm identities; moving/merging services, provider bundles, or runtime boundaries.
- Full recovery of absent release context, lost exact artifact evidence, or changed expired-upload-credential acceptance. These need a durable-intent/protocol decision.
- Conditional source-binding, lease/cleanup, or notification deduplication that adds machinery or changes cancellation/concurrent-configuration behavior.
- Builder behavior, production mutations, publication, push, and deployment.

## Decisions

- The user approved the complete behavior-preserving cleanup/repair batch and atomic commits after review and verification.
- Corrupt queue deliveries retry with existing backoff until their configured budget, then acknowledge with metadata-only diagnostics. Other deliveries continue. Valid exhausted ingest deliveries retain archive-before-ack.
- Raw queue claiming is additive. Existing published `claim()` and injectable queue implementations remain supported.
- Shared settings must preserve iteration/effect order; no ordering framework is introduced to manufacture a source-line saving.
- Existing release contexts are the only authority for bounded terminal repair. Never regenerate credentials or reconstruct release identity from current configuration.
- Terminal discovery uses a complete keyset scan per maintenance pass, with a bounded page size and captured upper boundary. Memory is bounded; total work scales with retained candidate rows. No persistent scan cursor or fixed total-work cap is introduced.

## Sequencing

1. WU1–4 run independently; freeze and independently review each diff.
2. WU5–8 run independently in separate package territories.
3. Freeze WU9's raw-delivery seam before adapting the Operations consumer. WU10 lands before WU11.
4. WU12–14 are independent of those units; shared exports belong to their respective owner.
5. Run integrated typecheck, lint, formatting, platform tests and release metadata validation. Record real-backend and live-provider limits explicitly.

## Run log

- 2026-10-04: Scope approved. Three independent read-only specifications identified queue compatibility and bounded release-repair constraints before implementation.
- WU1 → `a30a04c`: removed unused private APIs; production net −156 lines. Review clean.
- WU2 → `823cb86`: owned execution failures and child/pump cleanup. Review clean.
- WU3 → `2f4911e`: serialized/coalesced log snapshots and joined final persistence. Review clean.
- WU4 → `a0045c2`: reused validated manifest results and parsed descriptor setup selection. Review clean. Binding-map removal and composite cleanup extraction deferred because a smaller equivalent implementation was not established.
- WU1–4 coordinator checks: 542 tests passed with PostgreSQL enabled; four package typechecks, scoped lint/format checks passed.
- WU5 → `4e3c4f3`: persisted App credentials before loopback acknowledgement; delayed/failing filesystem witnesses. Review clean.
- WU8 → `3dbbde4`: shared existing console widgets; production TS/TSX net −134 lines. Review clean.
- WU5/WU8 coordinator checks: 58 tests passed, three package typechecks and dashboard production build passed; scoped lint/format checks passed.
- WU6: common-settings extraction deferred because exact effect order needs additional lookup/reordering machinery. Independent review requested removal of extraction-only matrix tests; guidance/recovery tests remain.
- WU7: independent review found lost real recovery and duplicate failure alerts across unavailable observations. Fix round reuses durable telemetry transitions; no new state store.
- WU14: workflow-only artifact reuse is feasible but adds 28 lines and upload/download/checksum failure states. Deferred under the smaller-and-provable gate; no custom artifact framework introduced.
- WU6 → `7928e88`: corrected partial-bootstrap and remote credential recovery guidance; removed unused prompt. Extraction-only tests removed after review. Final review clean.
- WU12 → `1532ae7`: shared representable EC key-set parsing with honest unsupported-set denial; transports and caches remain distinct. Review clean.
- WU13 → `9b987c7`: reused provider-local config loading while retaining both existing wrapper contracts. Review clean.
- WU6/WU12/WU13 coordinator checks: 259 tests passed, five package typechecks and scoped lint/format checks passed.
- WU10 → `48c57e6`: structural release payload decoding preserves historical request hashes and receiver errors; sender rejects corrupt rows independently. Review clean.
- WU7/WU10 coordinator checks: 70 tests passed with PostgreSQL enabled, three package typechecks and scoped lint/format checks passed.
- WU7: second review found legacy `failed → stale → healthy` provenance resurrection. The user explicitly approved another narrow compatibility fix round.
- WU7 → `b175d7f`: removed false silence diagnoses and preserved real failure/recovery provenance across unavailable and legacy stale states. Both review findings resolved; final review clean.
- WU9 → `c9eb7f7`: raw per-delivery decode and settlement, legacy adapters retained, metadata-only corrupt-delivery disposition. Review clean; real PostgreSQL witnesses include failed acknowledgement, peer progress and visibility retry.
- WU15 → `62ffd26`: shared native destination policy; original grammar, wire validation and transport lifecycles preserved. Review clean.
- WU11: review found per-settled-row lease work exceeded a simulated Worker database-call budget. Fix round skips validated matching discovery snapshots before ownership; actual repair and diagnostics remain fenced.
- Integrated coordinator checks before the WU11 budget fix: 4,389 passed, 48 skipped, zero failures across root platform/DOM/builder commands with PostgreSQL enabled. Root typecheck, lint, format, generated-artifact check and release validation for 28 public packages passed. Dashboard production build passed.
- Full missing-context release recovery and expiry decisions → [backlog 95](../backlog/95-close-release-recovery-without-frozen-context.md).
- WU11 → `5628c58`: budget fix passed independent review and coordinator integrated checks. Matching contexts skip ownership; genuine repairs and malformed-context diagnostics remain fenced.
- Final integrated coordinator checks after the budget fix: 4,395 passed, 48 skipped, zero failures; root typecheck, lint, format check, generated artifacts and release metadata validation passed. Final review has no remaining findings.
