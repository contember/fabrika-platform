# Sprint — simplify deployment and Operations (2026-10-04)

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

## Sequencing

1. WU1–4 run independently; freeze and independently review each diff.
2. WU5–8 run independently in separate package territories.
3. Freeze WU9's raw-delivery seam before adapting the Operations consumer. WU10 lands before WU11.
4. WU12–14 are independent of those units; shared exports belong to their respective owner.
5. Run integrated typecheck, lint, formatting, platform tests and release metadata validation. Record real-backend and live-provider limits explicitly.

## Run log

- 2026-10-04: Scope approved. Three independent read-only specifications identified queue compatibility and bounded release-repair constraints before implementation.
- WU1: Implementation and independent review complete; coordinator verification pending.
- WU2: Implementation and independent review complete; coordinator verification pending.
- WU3: Implementation and independent review complete; coordinator verification pending.
- WU4: Implementation complete; independent review and coordinator verification pending. Binding-map removal and composite cleanup extraction deferred because a smaller equivalent implementation was not established.
