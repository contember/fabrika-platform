> **OUTCOME — shipped 2026-07-31.** Operations now produces every supported error alert, detects spikes at the promised one-minute cadence, exposes complete issue read models and delivery history, and restores Poplach's Errors exploration and triage workflows in the unified console. Commit map: WU1 → `9eefc51`, `6fbef23`; WU2 → `927340e`; WU3 → `83581a9`; WU4 → sprint-closing commit. Verification: focused Operations/UI/Zerops suites 151 pass, 5 external-backend skips; full repository suite 1402 pass, 134 external-backend skips; full typecheck and lint pass; format check passes after closure formatting. Backlog filed: 46 for portable email delivery. Deferred: credentialed Poplach cutover (34), Zerops artifact correlation (36), DNS-safe egress (38), and live Postgres/S3 witnesses.

# Sprint — Operations functional parity (2026-07-31)

**Goal.** Close the functional gaps between the absorbed Poplach Errors slice and the Operations plane for error ingest, grouping, alerting, issue exploration, and triage.

**Theme.** The first Operations sprints established the portable plane and adoption proof. This sprint makes its error workflows operationally equivalent to the pinned Poplach source instead of merely exposing compatible storage and configuration surfaces.

## Refs re-verified at HEAD (2026-07-31)

- ✔ Sentry ingest parses official envelopes, applies SDK/default fingerprints, and stores exact occurrences — `packages/operations/src/ingest.ts:255`, `packages/operations/src/pipeline.ts:48`.
- ✔ Queue consumers coalesce at most 50 events for one source and effective fingerprint — `packages/operations/src/consumer.ts:12`, `packages/operations/src/pipeline.ts:65`.
- ⚠ Error alert configuration and delivery infrastructure exist, but ingest does not enqueue `new_issue` or `regression` notifications — `packages/operations/src/consumer.ts:43`, `packages/operations/src/repositories.ts:1282`.
- ⚠ Spike evaluation is a pure function with no scheduled producer — `packages/operations/src/alerts.ts:15`, `packages/operations/src/worker.ts:62`, `packages/operations/src/node/cron.ts:3`.
- ⚠ The operator API returns empty trends and canonical issue counts exclude historical occurrences of merged children — `packages/operations/src/operator-api.ts:730`, `packages/operations/src/repositories.ts:909`.
- ⚠ The Errors route fetches one fixed page and the detail route fetches only the latest occurrence — `packages/operations-ui/src/routes/errors/index.tsx:7`, `packages/operations-ui/src/routes/errors/detail.tsx:7`.
- ✔ Count snooze and release resolution exist in the domain and API; only count snooze is absent from the UI — `packages/operations/src/issues.ts:61`, `packages/operations-ui/src/views/ErrorDetail.tsx:175`.
- ✔ Poplach's pinned implementation wires new/regression alerts during consume and spike detection during cron — `../poplach/src/lib/consume.ts:349`, `../poplach/src/cron.ts:17`.

## Work units

### WU1 — Produce every configured error alert (effort L)

- **Problem.** `new_issue`, `regression`, and `spike` can be configured, but no production path creates their outbox notifications.
- **Verify first.** Prove by static call-site search and add failing tests at the consumer and scheduled-maintenance boundaries.
- **Scope.** Enqueue idempotent new-issue and regression notifications from persisted ingest transitions. Detect source-local one-minute spikes on both runtimes. Reuse alert claims and the existing leased webhook outbox.
- **Acceptance / witness.** Focused tests prove ingest → transition → one outbox row, duplicate delivery → no duplicate row, scheduled spike → one row per claim window, and outbox → webhook delivery.
- **Touch points.** `packages/operations/src/{consumer,pipeline,alerts,repositories,maintenance,worker}.ts`, `packages/operations/src/node/*`, Operations tests.

### WU2 — Restore issue data parity (effort L)

- **Problem.** Server query capabilities are not fully surfaced; trends are empty; detail exposes one event; merged canonical totals omit historical child occurrences.
- **Verify first.** Add repository/API tests for more than one page, merged-child history, bucketed trends, and occurrence navigation.
- **Scope.** Provide server-side source/status/level/window/query/assignee/sort filters with cursor pagination; aggregate merged descendants into counts and trends; expose issue occurrence history and stable event selection; expose notification delivery/attempt history to operators.
- **Acceptance / witness.** SQLite and operator API tests prove filters, stable pagination, merged totals, non-empty trend buckets, event navigation, and source-scoped alert delivery history.
- **Touch points.** `packages/operations-contract/src/operator-api.ts`, `packages/operations/src/{repositories,operator-api,operator-rpc}.ts`, migrations only if required.

### WU3 — Restore Errors console workflows (effort L)

- **Problem.** Client-only filtering over a fixed 100-row snapshot hides older issues; detail omits event navigation, exception causes, tags, trends, and count snooze; merging requires an opaque token.
- **Verify first.** Extend view and route tests around controlled query state and mutation payloads.
- **Scope.** Drive filtering and pagination through the API; add source/level/window/assignee/sort controls and load-more/live refresh; render trends; navigate occurrences; show all exceptions and tags; expose time/count/release snooze; merge selected issues into a chosen canonical issue; show delivery history on alert settings.
- **Acceptance / witness.** Operations UI tests witness each control and payload, plus a browser-safe route flow over the typed RPC client.
- **Touch points.** `packages/operations-ui/src/routes/**`, `packages/operations-ui/src/views/**`, `packages/operations-ui/src/client.ts`, dashboard styles only where existing tokens are insufficient.

### WU4 — Verify, document, and close the parity claim (effort M)

- **Problem.** Existing inventory evidence checks components separately and overstates end-to-end alert coverage.
- **Verify first.** Reconcile the pinned Poplach inventory against production call sites and the new witnesses.
- **Scope.** Add an end-to-end alerting witness, update current Operations reference, correct the inventory claim, run package and repository gates, and archive this sprint with exact results.
- **Acceptance / witness.** Focused Operations tests, full typecheck, lint, format check, and full test suite pass; skipped external-backend suites are reported explicitly.
- **Touch points.** `tests/browser/legacy-poplach-inventory.md`, `docs/reference/*`, this sprint, docs indexes.

## Out of scope (explicit)

- Live state adoption and retirement of standalone Poplach remain in [`backlog 34`](../backlog/34-retire-standalone-poplach.md); they require production credentials and a cutover window.
- Zerops source-map publication and Delivery correlation remain in [`backlog 36`](../backlog/36-complete-zerops-release-artifact-correlation.md); they require the provider build path, not Errors semantics.
- DNS-safe webhook and health-check egress remains in [`backlog 38`](../backlog/38-add-dns-safe-operations-egress.md).
- A portable email notification channel is separated into [`backlog 46`](../backlog/46-add-portable-email-alert-delivery.md). Poplach's Cloudflare Email Routing binding has no equivalent in the current multi-runtime notification contract; this sprint delivers complete alert semantics through the supported webhook channel.

## Decisions

- Alert producers write the existing durable outbox. They do not send inline from ingest or scheduled detection.
- Alert deduplication uses stable semantic claim keys before outbox insertion and the existing notification idempotency key during delivery.
- Historical merged occurrences remain immutable. Read models aggregate canonical issues with their merged children.
- No ADR is required for these choices: they complete the accepted Operations design in ADR-0016 and preserve the outbox and repository boundaries already at HEAD.

## Sequencing

1. Commit this contract.
2. Run WU1, WU2, and the UI portion of WU3 in parallel with explicit file ownership.
3. Integrate typed contracts, finish alert history UI, and run focused gates.
4. Run repository gates, update reference evidence, archive the sprint, and commit closure.

## Run log

- 2026-07-31 — Sprint opened from a source-level parity audit against pinned Poplach commit `8e0c79d662c187fe41eacd0fee9fe77fde668f1f`.
- 2026-07-31 — The five-minute Cloudflare and Zerops maintenance cadence could not observe every one-minute spike window; both composition roots now schedule one pass per minute.
- 2026-07-31 — Occurrence history changed from a proposed fixed cap to bounded keyset pagination so every stored event remains reachable.
- 2026-07-31 — Portable email delivery remains separate → [`backlog 46`](../backlog/46-add-portable-email-alert-delivery.md).
- 2026-07-31 — No ADR graduated: the implementation preserves ADR-0016, the existing outbox, and the repository portability seam.
