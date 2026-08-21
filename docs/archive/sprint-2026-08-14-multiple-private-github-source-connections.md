> **OUTCOME — closed 2026-08-21.** One Zerops installation connects and deploys private repositories
> from several GitHub organizations through keyed v2 credentials and connection-scoped webhooks
> (ADR-0032); `keyed-v2` scoped delivery, exact-commit private deploys, restart reconstruction and
> keyed-slot recovery (ADR-0036) were all witnessed live between 2026-08-14 and 2026-08-20. The legacy
> `legacy-v1` compatibility path this sprint preserved was retired with the account that held its only
> credential (ADR-0039, `b1c0849`), which voids the legacy generic-delivery gate rather than meeting it.
> Commit map (selected): v1/v2 rebinding `2cf6681`, `f668ff5`; scoped webhook URL `225e47b`; source
> failure reasons `407ff66`; browser manifest handoff `7fe3bec`; webhook reconciliation `b7bc771`;
> durable binding recovery `87aa2ed`; retirement `b1c0849`. Verification: the 2026-08-17 run-log gates
> (full `bun test` with a dedicated PostgreSQL 17, `release:validate`, Zerops `gen:check`) and the
> 2026-08-20 live witnesses recorded below. Deferred: a private deploy from a SECOND connected
> organization was never witnessed live; it moves to the cheap-rebuild sprint as WU8 item (7).

# Sprint — Multiple private GitHub source connections (2026-08-14)

**Goal.** Let one Zerops Fabrika installation connect and deploy private repositories from multiple
GitHub organizations without making any GitHub App public.

**Theme.** Replace the single-connection assumption with an explicit connection-and-installation
binding across credential custody, source RPC, Control persistence, webhooks, registry and dashboard,
while preserving the already-live v1 connection as a compatibility path. The governing decision is
[ADR-0032](../decisions/0032-support-multiple-private-github-source-connections.md).

## Refs re-verified at HEAD (2026-08-14)

`✔` = confirmed at HEAD · `⚠` = a compatibility nuance the implementation must preserve.

- ✔ SQLite/D1 allows one active setup and one connected row through constant-expression/singleton
  constraints — `packages/control/migrations/0019_github_source_connections.sql:64` and
  `packages/control/migrations/0019_github_source_connections.sql:68`.
- ✔ PostgreSQL mirrors both constraints —
  `packages/control/migrations-postgres/0015_github_source_connections.sql:48` and
  `packages/control/migrations-postgres/0015_github_source_connections.sql:52`.
- ✔ Control reads only singleton `1`, publishes only singleton `1`, and projects one connection state —
  `packages/control/src/github-connection-store.ts:412`,
  `packages/control/src/github-connection-store.ts:447` and
  `packages/control/src/github-connection-store.ts:755`.
- ✔ Start refuses any state other than anonymous, so a connected row prevents a second workflow —
  `packages/control/src/source-connection.ts:143`.
- ✔ The v1 credential bundle contains only App id and private key; its exact canonical bytes and size
  are already bounded — `packages/provider-zerops/src/source.ts:10`,
  `packages/provider-zerops/src/source.ts:29` and `packages/provider-zerops/src/source.ts:449`.
- ✔ Zerops writes one create-only `GITHUB_APP_CREDENTIALS` value and treats any different durable
  bundle as a conflict — `packages/provider-zerops/src/source-connection.ts:17` and
  `packages/provider-zerops/src/source-connection.ts:153`.
- ✔ Source imports only that base bundle at boot and reports GitHub enabled from one snapshot —
  `packages/source-zerops/src/config.ts:34`, `packages/source-zerops/src/config.ts:42` and
  `packages/source-zerops/src/config.ts:65`.
- ✔ Source owns one mutable active client and explicitly rejects activation under a different
  connection id — `packages/source-zerops/src/github-connection.ts:80` and
  `packages/source-zerops/src/github-connection.ts:129`.
- ✔ Source resolve and archive select the one snapshot client and receive only an optional installation
  id — `packages/source-zerops/src/repository.ts:19`,
  `packages/source-zerops/src/repository.ts:127` and
  `packages/source-zerops/src/repository.ts:204`.
- ✔ The v1 resolve and upload wire carries installation id but no connection id —
  `packages/provider-zerops/src/source.ts:162` and `packages/provider-zerops/src/source.ts:179`.
- ✔ The registry row and provider projection carry only `github_installation_id` —
  `packages/control/src/db.ts:20`, `packages/control/src/db.ts:328` and
  `packages/control/src/run-lifecycle.ts:126`.
- ✔ Control has one generic webhook route and proxy gate; its handler queries applications by repository
  only after one HMAC verifier accepts the body — `packages/control/src/app.ts:41`,
  `packages/control/fabrika.gates.ts:27` and `packages/control/src/webhook.ts:23`.
- ✔ The current setup programs that same generic URL into every manifest and completed row —
  `packages/control/src/source-connection.ts:299`,
  `packages/control/src/source-connection.ts:410` and
  `packages/control/src/source-connection.ts:692`.
- ✔ The dashboard loader and page render one status union and show the form only while anonymous —
  `packages/dashboard/src/routes/settings/source.tsx:17` and
  `packages/dashboard/src/routes/settings/source.tsx:61`.
- ⚠ Existing v1 startup can import a base bundle without knowing the connection id, then bind it on the
  first authenticated status/activation interaction — `packages/source-zerops/src/github-connection.ts:91`
  and `packages/source-zerops/src/github-connection.ts:179`. The migration must not require a v2 rewrite
  of that credential.

## Work units

### WU1 — Freeze all v2 source contracts and the compatibility matrix (effort M)

- **Problem.** The v1 credential bundle, credential activate/status, resolve and upload contracts were
  designed around one source client. The provider-neutral app source cannot name a connection, and the
  browser API returns one status instead of stable connections plus one workflow.
- **Verify first.** Pin exact v1 bundle, request/response, path and public-export fixtures. Confirm that
  no existing decoder accepts unknown fields and that the provider contract can add an optional
  connection id without weakening old envelope decoding.
- **Scope.** In `provider-zerops`, own and freeze the canonical credential bundle v2 plus bounded v2
  credential activate/status and source resolve/upload codecs, types, builders, decoders and exports.
  Freeze their paths as `/v2/source/credentials/activate`, `/v2/source/credentials/status`,
  `/v2/source/resolve` and `/v2/source/upload`. Add an optional connection id beside the
  provider-neutral installation id, with the Zerops v2 private-source path requiring both coordinates.
  Freeze and export the fixed-prefix v2 environment-slot key derivation consumed by WU3. Keep every v1
  codec, path and export compatible. Add paginated browser-safe connection list DTOs and one optional
  global setup projection. Keep mutation inputs keyed by connection id. Add no aggregate credential
  list and no connection-count constant.
- **Acceptance / witness.** Contract tests prove v1 golden bundles and messages still decode and encode
  unchanged; activate v2 binds the outer id to bundle v2 and status v2 is keyed by the exact id;
  resolve/upload v2 reject a missing or malformed connection/installation coordinate and unknown
  fields; public export tests cover every v1 and v2 symbol; DTO tests prove secrets cannot appear;
  pagination is bounded without limiting total rows.
- **Write territory.** All of `packages/provider-contract/**` and `packages/control-contract/**`;
  `packages/provider-zerops/src/source.ts`, `packages/provider-zerops/src/index.ts` and
  `packages/provider-zerops/src/__tests__/source.test.ts`. No later WU edits these paths.

### WU2 — Key source clients and serve v1 plus v2 (effort L)

- **Problem.** `GitHubConnection` owns one active snapshot. Repository resolve/archive cannot select a
  credential explicitly, and a restart cannot reconstruct a new connection id from a v1 bundle.
- **Verify first.** Run the source credential, service, repository and protocol test files. Record the
  current anonymous, v1 boot, activation race, digest conflict, resolve and upload fixtures.
- **Scope.** Consume WU1's canonical bundle v2 and discover and validate each v2 environment slot at
  boot. Build an immutable snapshot map keyed by connection id and add one new entry atomically after
  validation. Keep the v1 base snapshot as the sole legacy/default client. Route credential
  activate/status and resolve/upload v2 through the WU1 codecs by exact connection id and installation
  id. Keep v1 endpoints served and restricted to the default client. Preserve all archive, destination,
  timeout and redaction invariants from ADR-0029.
- **Acceptance / witness.** Unit and service tests boot two v2 bundles plus one v1 bundle, select the
  correct client for concurrent resolve/upload calls, reject slot/bundle/request mismatches, reject
  duplicate connection ids, and prove v1 never reaches a v2-only client. A malformed persisted slot
  prevents startup without logging credential bytes.
- **Write territory.** `packages/source-zerops/src/config.ts`,
  `packages/source-zerops/src/github-connection.ts`, `packages/source-zerops/src/repository.ts`,
  `packages/source-zerops/src/service.ts` and `packages/source-zerops/src/__tests__/**`. WU1
  exclusively owns every provider contract and `packages/provider-zerops/src/source.ts`.

### WU3 — Persist one create-only Zerops credential slot per connection (effort L)

- **Problem.** The provider inspects and writes one fixed environment name and rejects a second bundle.
  The current environment inspection also applies an aggregate entry bound that would become an
  accidental connection cap.
- **Verify first.** Preserve fixtures for anonymous source, legacy split credentials, base v1 bundle,
  exact reread, duplicate env entries, masked/missing values and ambiguous create response recovery.
  Before choosing an inspection strategy, measure live whether Zerops offers exact-key lookup or
  pagination and record the maximum observable response shape. Confirm the live environment-key grammar
  before relying on the v2 key shape.
- **Scope.** Use WU1's fixed-prefix environment-key derivation and canonical bundle v2 serializer. Use
  create-only write plus exact reread for that one slot. Use exact-key lookup or pagination only if the
  live measurement proves it. Otherwise select the requested slot from a full environment response
  protected by an explicit response-body byte bound, not by an entry-count cap. Retain bounds for key,
  value, retry sequence and RPC body. Keep adoption and base v1 inspection unchanged for the migrated
  connection.
- **Acceptance / witness.** Provider tests persist two distinct v2 slots without rewriting the first,
  make duplicate activation idempotent, reject a pre-existing different value, and prove exact reread
  before activation. A response above the byte bound fails before unbounded parsing, while any number
  of entries inside the bound is accepted. Legacy adoption tests remain green. No exported or internal
  constant represents a maximum number of connections.
- **Write territory.** `packages/provider-zerops/src/source-connection.ts`,
  `packages/provider-zerops/src/api.ts`, `packages/provider-zerops/src/__tests__/source-connection.test.ts`
  and `packages/provider-zerops/src/__tests__/api.test.ts`. WU1 exclusively owns
  `packages/provider-zerops/src/source.ts`; WU6 exclusively owns all installation artifacts.

### WU4 — Add keyed Control persistence and registry pairs (effort L)

- **Problem.** Both database implementations have a singleton connection row. Application registry
  state has only an installation id, so deploy and webhook paths cannot prove which App credential it
  belongs to.
- **Verify first.** Run SQLite/D1 and PostgreSQL migration suites against pre-0032 fixtures containing
  one connection, connected and repair-required attempts, public apps and private apps. Confirm the
  historical migration filenames and bundles remain unchanged.
- **Scope.** Add new SQLite/D1 and PostgreSQL migrations. Create an authoritative keyed connection
  table with immutable `transportKind`; copy the singleton as the sole `legacy-v1` row without editing
  or dropping it, and mark every new row `keyed-v2`. Add case-insensitive organization uniqueness for
  new private connections. Enforce one global attempt whose status is `active` or `repair_required`.
  Add nullable `github_connection_id` to the shared app table. Enforce the pair with
  `github_installation_id` in Zerops registration and repository operations, not with a global table
  check: Cloudflare rows may legitimately carry only an installation id. Backfill only when the app's
  installation matches the copied connection, `EXISTS` a matching `app_envs` row with
  `provider = 'zerops'`, and no `app_envs` row has another provider. Explicitly skip mixed-provider
  apps so their Zerops path later fails the partial-pair check. Add exact-pair Zerops repository queries
  and paginated connection repository methods. Never rename an existing migration or bundle.
- **Acceptance / witness.** Fresh and upgrade migration tests pass on SQLite and PostgreSQL. The
  copied row is the only `legacy-v1` row and retains every coordinate; two `keyed-v2` organization rows
  coexist; transport kind cannot change; duplicate case-folded owners and simultaneous nonterminal
  attempts fail. A matching Zerops app is backfilled, a mismatched installation is not, and a
  mixed-provider app is explicitly skipped and rejected by the Zerops operation guard. A Cloudflare
  row with `github_installation_id` and no `github_connection_id` remains valid and is not backfilled.
- **Write territory.** New files only under `packages/control/migrations/` and
  `packages/control/migrations-postgres/`; `packages/control/src/github-connection-store.ts`,
  `packages/control/src/db.ts`,
  `packages/control/src/__tests__/github-connection-store.test.ts`,
  `packages/control/src/__tests__/postgres-schema.test.ts`,
  `packages/control/src/__tests__/repository-composition.test.ts` and
  `packages/control/src/__tests__/helpers/harness.ts`. Later Control WUs consume this persistence seam
  without editing its files or shared harness.

### WU5 — Make the Control workflow additive and owner-selecting (effort L)

- **Problem.** Status, start, adoption, verify and repair all project one singleton. Start explicitly
  requires anonymous source state, and onboarding asks the one source client to discover an
  installation.
- **Verify first.** Preserve manifest one-use, principal/origin binding, callback CAS, encrypted
  recovery deletion, audit and repair-state tests. Add a fixture with one connected row before changing
  start eligibility.
- **Scope.** Return stable connections plus the one workflow. Allow `Add connection` while connections
  exist, but reject another nonterminal workflow and another private connection for the same owner.
  Create only private Apps in the new multi-connection action. Generate v2 credential bundles and
  scoped webhook URLs. Select the connected organization by canonical repository owner during
  onboarding and persist the exact connection/installation pair. Keep legacy adoption narrow and
  preserve all redaction and authorization checks from ADR-0031.
- **Acceptance / witness.** Workflow tests start and complete a second organization beside the migrated
  connection, reject a same-owner connection, recover an interrupted second setup without disturbing
  the first, and bind new Zerops private apps to the expected pair. No browser/API response or log
  contains a credential or manifest capability. Tests also prove the temporary KEK-encrypted recovery
  entry is deleted after configuration verification and is never projected into the connected row.
- **Write territory.** `packages/control/src/source-connection.ts`,
  `packages/control/src/source-connection-port.ts`, `packages/control/src/control-rpc.ts`,
  `packages/control/src/api/registry.ts`, `packages/control/src/node/source-connection.ts`,
  `packages/control/src/node/runtime.ts`, `packages/control/src/node/provider.ts`,
  `packages/control/src/__tests__/source-connection.test.ts`,
  `packages/control/src/__tests__/registry.test.ts`,
  `packages/control/src/__tests__/node-provider.test.ts`. It consumes WU4's database and harness files
  without editing them.

### WU6 — Scope webhook verification and triggering (effort L)

- **Problem.** One public URL resolves one secret and then matches only repository/ref. With several
  Apps it could authenticate with one connection and trigger an application bound to another.
- **Verify first.** Preserve raw-body HMAC-before-parse behavior, uniform invalid-signature behavior,
  ref matching, no-subscriber acknowledgement and multi-environment triggering fixtures.
- **Scope.** Add `/webhooks/github/:connectionId` to shared routing and proxy gates. Resolve one exact
  connection and encrypted secret before HMAC verification. After verification require the event's
  installation id and exact registry pair. In the Zerops composition, retain `/webhooks/github` for
  only the migrated `legacy-v1` connection and its legacy-bound apps. Preserve the Cloudflare
  composition's static-secret verification and installation-id routing on that generic path. Do not
  try multiple secrets or fall back between Zerops routes. Own every resulting
  `installation-zerops`, `local-stack` and `proxy-core` compatibility or generated-artifact change,
  including the composed legacy-plus-two-v2 local fixture consumed by later verification.
- **Acceptance / witness.** Tests prove two Apps can sign identical repository-shaped payloads but each
  scoped route accepts only its own secret and installation. Cross-connection, unknown-id and
  installation-mismatch requests trigger no runs. The generic path continues to trigger only the
  Zerops legacy pair. A dedicated Cloudflare regression fixture proves its generic webhook still uses
  the static secret and installation id without a source connection row. Generated Zerops proxy
  manifests expose both exact route families and remain equal to source gates.
- **Write territory.** `packages/control/src/app.ts`, `packages/control/src/webhook.ts`,
  `packages/control/src/repo-source.ts`, `packages/control/src/services.ts`,
  `packages/control/src/env.ts`, `packages/control/src/platform-cf.ts`,
  `packages/control/fabrika.gates.ts`, `packages/control/src/__tests__/app.test.ts`,
  `packages/control/src/__tests__/webhook.test.ts` and
  `packages/control/src/__tests__/repo-source.test.ts`,
  `packages/control/src/__tests__/platform-cf.test.ts`; all of `packages/proxy-core/**`,
  `packages/installation-zerops/**` and `packages/local-stack/**`, including their focused tests and
  generated artifacts. It consumes WU4's shared Control test harness without editing it.

### WU7 — Route deploys through source v2 without breaking v1 (effort M)

- **Problem.** Provider app projection, resolve and upload propagate only installation id. A second App
  cannot be selected safely, and an old source must still handle the migrated legacy path during
  rollout.
- **Verify first.** Preserve provider artifact, exact-commit, descriptor digest, recovery checkpoint,
  upload destination and cancellation fixtures. Record v1 request bodies as compatibility witnesses.
- **Scope.** Consume WU1's optional provider-neutral connection id and carry the Zerops registry pair
  through the run lifecycle, provider normalization, resolve and upload. Load its keyed connection row
  and select v1 for `legacy-v1` or v2 for `keyed-v2`; field presence and prior status calls never select
  the protocol. Reject a missing row, partial Zerops pair or response-coordinate mismatch without
  changing Cloudflare's installation-id-only model.
- **Acceptance / witness.** Provider and Control integration tests resolve and upload concurrent runs
  through two connection ids, prove the exact pair reaches source, and fail closed on swapped ids. The
  unchanged legacy fixture still uses v1 and completes. After a source restart, an immediate legacy
  deploy succeeds through v1 without any UI status or activation call first. Source/client errors
  remain detail-free.
- **Write territory.** `packages/control/src/run-lifecycle.ts`,
  `packages/control/src/node/source-client.ts`, `packages/control/src/__tests__/run-lifecycle.test.ts`,
  `packages/control/src/node/__tests__/source-client.test.ts`,
  `packages/provider-zerops/src/control.ts`, `packages/provider-zerops/src/provider.ts`,
  `packages/provider-zerops/src/__tests__/control.test.ts` and
  `packages/provider-zerops/src/__tests__/provider.test.ts`. WU1 solely owns all
  `packages/provider-contract/**` changes.

### WU8 — Present a connection collection in the dashboard (effort M)

- **Problem.** `/settings/source` renders one discriminated state and hides creation after it reaches
  connected.
- **Verify first.** Preserve same-origin full-page manifest navigation, polling only for pending state,
  installation link behavior, repair action and browser-safe DTO compile tests.
- **Scope.** Render connected organizations as stable cards or rows. Render the one setup/repair
  workflow separately. Add `Add connection` for a new private organization while other rows remain
  visible. Paginate or incrementally load the collection. Keep adoption as a legacy-only empty-state
  action. Add the source-connection browser scenario under `tests/browser/` if the local stack supports
  it. Do not add delete, rotate, public visibility or cross-organization controls.
- **Acceptance / witness.** Component tests cover zero, one migrated and several connections; add,
  callback resume, install, verify and repair target the correct id; pending polling does not hide
  stable rows; accessibility names distinguish organizations. A browser test completes a second
  mocked organization flow without exposing secret fields.
- **Write territory.** All of `packages/dashboard/**`; a new
  `tests/browser/source-connections.test.ts` scenario only. WU8 may consume existing browser support
  helpers and WU6's local-stack fixture but does not edit either.

### WU9 — Read-only integration and release gates (effort M)

- **Problem.** The change crosses published packages, generated Zerops manifests, two SQL dialects and
  the shared local/browser stack. Package-green tests alone cannot prove the composed pair routing.
- **Verify first.** Ensure required backends are available; report skipped PostgreSQL/S3 suites
  explicitly. Reserve CPU before full suites or builds.
- **Scope.** Perform read-only integration verification over the code, tests, local fixture and
  generated artifacts delivered by WU1–WU8. Run the composed legacy-plus-two-v2 scenario, packaging and
  dependency-direction checks. Do not add or edit tests, artifacts, local-stack files, reference docs
  or implementation. Route any discovered gap back to the WU that owns that path.
- **Acceptance / witness.** The local scenario proves distinct credentials, status, scoped webhooks,
  registry pairs, resolve and upload coordinates. Deterministic negative tests prove swapped secrets,
  connections and installations cannot cross-trigger or cross-deploy. Run format check, lint, full
  typecheck, full tests, browser tests where supported, generated-manifest checks and
  `release:validate`. PostgreSQL source connection migrations and repository operations run against
  `FABRIKA_TEST_POSTGRES_URL`; a skip is recorded as unverified, not green evidence.
- **Write territory.** None. WU9 runs commands and reports evidence only.

### WU10 — Roll out and collect live-only witnesses (effort L) · partially complete

- **Problem.** Local doubles cannot prove Zerops accepts dynamic hashed environment keys, exact reread
  survives a source restart, or GitHub and Zerops complete a real second-organization deployment.
- **Verify first.** Confirm the current live connection, source image and generic webhook are healthy.
  Confirm access to a second GitHub organization and a private test repository before rollout. Do not
  alter the existing App, secret or base v1 environment value. Confirm WU3 already recorded Zerops'
  actual environment lookup/pagination behavior and implemented only the behavior that probe proved.
- **Scope.** Deploy source first and prove v1 compatibility. Deploy proxy second and probe both webhook
  paths. Deploy Control/dashboard last. Create a second private organization connection through the UI,
  restart source, verify both clients recover, register the second organization's repository and deploy
  it. Exercise one genuine positive delivery from an App bound to `legacy-v1` through the generic
  `/webhooks/github` route and one from the new App through its keyed-v2 scoped
  `/webhooks/github/:connectionId` route.
- **Acceptance / witness.** Record these live facts with redacted identifiers and timestamps:
  (1) Zerops accepts the derived create-only v2 environment key and exact value reread;
  (2) source restart reconstructs the old v1 client and the new v2 client;
  (3) a migrated `legacy-v1` connection's generic webhook/deploy remains healthy;
  (4) a second private organization App completes callback, install and verification;
  (5) that organization's private repository resolves, uploads, builds and becomes active;
  (6) one genuine positive delivery from an App bound to `legacy-v1` through the generic
  `/webhooks/github` route triggers its bound app; and (7) one genuine positive delivery from the new
  App through its keyed-v2 scoped `/webhooks/github/:connectionId` route triggers its bound app.
  Negative cross-binding isolation remains a deterministic local gate unless a separately reviewed
  safe live method is established. A missing positive witness keeps the sprint open.
- **Write territory.** No repository files. WU10 changes only the authorized live GitHub/Zerops state
  and triggers the deployment workflow. It returns redacted witness facts to WU0 for the sprint log;
  no credential value enters that report.

## Out of scope (explicit)

- Delete, disconnect or credential rotation. Create-only slot lifecycle needs its own decision before
  destructive behavior is added.
- Moving an already-registered application between connections without re-registration.
- One public GitHub App installed across organizations. Existing legacy public state remains readable,
  but the new connection action creates private Apps.
- GitHub Enterprise Server or configurable GitHub/API origins.
- Multiple source containers, broadcast activation or shared dynamic credential storage.
- A source rollback after v2 credentials exist. The documented recovery is roll forward; an old source
  must fail v2 calls closed.
- Any Fabrika-defined maximum number of connections. Per-body, per-page and per-repository-list bounds
  remain security requirements, not total-count limits.

## Decisions

- [ADR-0032](../decisions/0032-support-multiple-private-github-source-connections.md) owns the
  organization-private model, create-only keyed credentials, additive compatibility, exact webhook and
  registry binding, no explicit count cap and rollout order.
- The existing singleton table and base v1 credential remain compatibility evidence. Its copied keyed
  row is the sole immutable `legacy-v1`; every new row is immutable `keyed-v2`. The generic webhook is
  legacy-pair-only in Zerops, while Cloudflare preserves static-secret and installation-id behavior.
- One global nonterminal workflow is sufficient. Stable connection rows are plural and do not block
  `Add connection`.
- Individual payloads stay bounded and Control collection reads paginate. Zerops environment
  pagination or targeted lookup is used only if live measurement proves it; otherwise a byte-bounded
  full response is valid. Resource safety must not be implemented as a total connection-count constant.

## Sequencing

| Order | Work                        | Dependency and gate                                                                                 |
| ----- | --------------------------- | --------------------------------------------------------------------------------------------------- |
| 1     | WU1 + WU3 live read probe   | Freeze all v2 contracts; measure Zerops environment lookup/pagination before designing persistence. |
| 2     | WU2 and WU4                 | Source map and additive persistence can proceed independently after WU1.                            |
| 3     | WU3 implementation          | Use only the measured environment-read behavior plus WU1 codecs and WU2 activation.                 |
| 4     | WU5 and WU7                 | Join keyed persistence and immutable transport markers to provider/source coordinates.              |
| 5     | WU6                         | Land scoped Zerops route after exact lookup; preserve Cloudflare generic behavior.                  |
| 6     | WU8                         | Consume the stable collection/workflow DTO after Control behavior settles.                          |
| 7     | WU9                         | Compose every local seam and run full release gates.                                                |
| 8     | WU0 documentation           | Record verified behavior/run evidence and update affected reference docs.                           |
| 9     | Remaining WU10 live rollout | Roll out source → proxy → Control/dashboard and collect positive live witnesses.                    |

No implementation unit may remove v1 behavior before the live v2 witness. Every unit lands with its
focused tests; cross-unit integration and reference-doc updates land before the live rollout.

### Write-ownership rule

- WU1–WU8 own only the paths listed in their `Write territory`. Their focused and integration tests
  must live inside those same territories.
- WU0/spec leadership exclusively owns `docs/**`, including this sprint's run log, outcome, indexes and
  later reference updates. Implementation WUs do not edit documentation.
- WU9 and WU10 have no repository write territory. WU9 verifies; WU10 changes only authorized live
  external state and reports redacted evidence to WU0.
- If a WU discovers that completion requires an unlisted file or a file owned by another WU, it stops
  and asks the leader to reassign that exact path before editing. No shared helper, test, generated
  artifact or documentation file is edited concurrently.

## Verification gates

### Local gates

- Focused contract, source, provider, Control persistence/workflow/webhook and dashboard tests.
- Fresh and upgrade migrations on SQLite/D1 and PostgreSQL.
- Generated proxy/source manifest equality and Zerops artifact generation.
- `bun run format:check` and `bun run lint`.
- `cpu-lease run -n 4 -- bun run typecheck`.
- `cpu-lease run -n 4 -- bun test`, with backend-dependent skips reported separately.
- `FABRIKA_TEST_POSTGRES_URL=...` PostgreSQL source-connection migration and repository tests.
- `cpu-lease run -n 4 -- bun run release:validate`.
- Local composed legacy-plus-two-v2 source flow. The GitHub manifest/install browser E2E remains a
  live-only gate because the local fixture does not support it.

### Live-only gates

- ✔ Zerops accepted derived hashed environment keys, exact reread completed, and the legacy base plus
  three keyed-v2 slots persisted across source restarts.
- ✔ Two additional organization-owned private Apps completed create, install and verification through
  Control.
- ✔ A genuine keyed-v2 scoped `/webhooks/github/:connectionId` delivery reached its bound private
  application and deployed it.
- ⚠ A private repository owned by a second connected organization still must resolve, upload, build
  and deploy on Zerops.
- ⚠ A genuine `legacy-v1` connection still must deliver through the generic `/webhooks/github` route
  to its bound application. The live application used for the keyed witness is not a substitute.
- ✔ Negative cross-binding isolation is proved deterministically in the local composed fixture.

## Run log

<!-- Append as implementation proceeds. Do not place credential values, manifest codes, webhook
     secrets, presigned URLs or source RPC keys here. Graduate durable discoveries per docs/CLAUDE.md. -->

- 2026-08-14 — Plan accepted with no explicit connection-count limit. Implementation not yet claimed
  complete; local and live gates above remain required.
- 2026-08-17 — ADR and implementation landed as `3e102ae` (`docs(github): decide multiple private
  source connections`), `7ba3e19` (`feat(source): define multi-connection contracts`), `99cce8e`
  (`feat(source): route multiple GitHub connections`), `42b43d2` (`feat(control): persist keyed GitHub
  connections`), `ca9205e` (`feat(zerops): persist keyed source credentials`), `ce4a411`
  (`feat(zerops): route deploys by source connection`), `a8734c2` (`feat(control): scope GitHub source
  webhooks`), `6549fe0` (`feat(control): manage multiple GitHub connections`) and `882e6c5`
  (`feat(dashboard): manage multiple GitHub connections`). The sprint stays active for WU10.
- 2026-08-17 — WU9 deterministic local compatibility and isolation gates passed: full tests reported
  2,478 pass, 162 skip and 0 fail; full typecheck passed; `format:check` and lint exited 0. Lint reported
  six warnings and 825 infos, with no changed-file error. `release:validate` checked 23 packages, and
  Zerops `gen:check` checked 11 generated artifacts. The WU6 local-stack witness composes one legacy v1
  plus two keyed v2 source credentials, seeds all three keyed Control rows with vault-encrypted webhook
  secrets, and exposes the generic plus scoped proxy paths. A dedicated PostgreSQL 17 run on a
  temporary local instance first exposed an upgrade-fixture error that passed only the last migration
  into the second step. The separate `65bc44b` fixture fix (`fix(control): exercise full Postgres
  upgrade plan`) passes the full migration list; `postgres-schema.test.ts` then passed 29 tests, 217
  assertions and 0 failures, including keyed upgrade/backfill, callback compare-and-set and two
  real-connection secret/publish races. The temporary container was stopped and removed. S3-dependent
  suites skipped without `FABRIKA_TEST_S3_*`; that skip is not S3 backend evidence. The local fixture
  does not support the GitHub manifest/install browser E2E, so that witness remains live WU10 work.
- 2026-08-17 — WU10 remains open. Live Zerops must still prove the derived v2 environment slot and
  exact reread, restart reconstruction of v1 plus v2, continued legacy generic webhook/deploy health,
  a second private organization App create/install/verify flow, its private repository deploy, and
  one genuine positive delivery through the existing App's legacy-v1 generic `/webhooks/github` route
  plus one through the new App's keyed-v2 scoped `/webhooks/github/:connectionId` route.
- 2026-08-20 — The live setup now has three connected organization-owned Apps. Two additional
  organizations completed create/install/verify through the browser. Zerops currently holds the
  legacy base credential plus three derived keyed-v2 slots; all survived subsequent source rollouts,
  and the service boots with the combined set. Recovery and reconciliation repaired one keyed slot
  whose stable Control row had outlived its source credential. A private push then traversed that
  connection's scoped webhook, created run `01a01f7c-037b-702e-8ec8-b3f186144b22`, resolved exact
  commit `0d608e0071119c85ac144f78c1ad1509f7a22ab7`, uploaded the archive and reached `ACTIVE` with
  `/healthz` 200. A second exact-commit private run and later release rollout reconfirmed keyed-v2
  resolution after restart. WU10 therefore retains two live gates: deploy a private repository owned
  by a second connected organization, and trigger one bound application through a genuine
  `legacy-v1` generic `/webhooks/github` delivery. The current proven application is keyed-v2, so its
  successful scoped delivery cannot satisfy the legacy gate.
