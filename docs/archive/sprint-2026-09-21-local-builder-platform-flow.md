# Sprint — Connect the local builder to an installed platform (2026-09-21)

## OUTCOME — 2026-09-23

Implemented the local-first Builder connection and deployment flow. The installed console records human application/placement consent; IAM issues an app-scoped credential directly to the local daemon. Local CLI/UI expose connection, preview and exact-source deployment, including repeated updates. No push, publication or production deployment was performed.

### Commit map

- `fca3840` — frozen contracts and ADR-0042.
- `214cda7` — daemon HTTP/WebSocket admission.
- `a35615c` — platform-managed Zerops catalog.
- `b36799a` — IAM device authorization and scoped issuance.
- `693213d` — Control receipts, pairing and shared local DTOs.
- `c6ca94f` — console consent/revocation and generated proxy gates.
- `883e9f7` — CLI commands and installed agent guidance.
- `ad10beb` — local connection/deployment/preview UI and isolated tests.
- `b27798e` — actual cross-plane consent and repeat-deployment witness.
- `ec3a4b9` — daemon custody, deployment lifecycle and canvas read protection.

### Verification

- Main repository suite with real PostgreSQL: 3,232 passed, 46 skipped, zero failures.
- Agent-interface suites: 310 passed, zero failures.
- Final Builder suite: 164 passed, zero failures; includes a subprocess running eight real-kernel custody tests. An earlier run failed its macro witness; the final rerun passes after the native parser guard fix.
- Cross-plane integration: non-admin human → real IAM/proxy/Control → two successful Control executions with a deterministic provider, distinct pushed SHAs, retained placement and revoked-key rejection (33 assertions).
- Final full-repository typecheck passed. Dashboard and local Builder production builds passed. Formatting, generated Zerops checks, frozen installation and release validation passed. Root lint exits zero with existing unrelated warnings.
- The user approved one explicit Bun declaration compatibility assertion at the native `macro: false` parser boundary. Runtime regression tests cover direct, transitive and data-URL macro attempts. No dependency patch was retained.

### Limits and accepted deferrals

- Real browser/login/Caddy verification was explicitly waived after Docker exhausted its address pools. The deterministic provider is not evidence of real Zerops behavior; no real deployment was authorized.
- S3-backed tests remain skipped: the CI-pinned MinIO image pull was denied. Live-provider tests were not configured.
- The user deferred credential replacement during an active run. Expiry/revocation leaves the saved run and target blocked. A lost submission response before saving a run ID also stays reserved without automatic reset or retrigger.
- Deployment requires attached HEAD equal to its remote branch tip. The flow does not freeze a manifest against concurrent Control registry changes.
- Backlog 78 remains the separate operator-oriented create-only command, not this human-consent Builder flow.

Current usage and recovery limits: [local-builder reference](../reference/local-builder.md).

## Original plan

**Goal.** A person connects their local builder through browser consent, creates or selects an application in the installed console, builds locally, deploys through Control, and repeats the workflow without registering a duplicate application.

**Theme.** Keep coding agents and application execution local while making application identity and deployment continuous with the installed platform. Initial delivery targets Zerops.

## Refs re-verified at HEAD (2026-09-21)

- ✔ `packages/builder/cli/src/layout.ts:17` stores only profile, session ID and creation time; connection metadata is new.
- ✔ `packages/builder/daemon/src/index.ts:60` binds to localhost but does not admit HTTP/WebSocket requests by authority and origin.
- ✔ `packages/control-contract/src/rpc.ts:117` already exposes application creation, environment replacement, deploy and run polling.
- ✔ `packages/iam/src/issue.ts:70` supports delegated service-principal keys; credentials are hash-only and grants are scope-checked.
- ✔ `packages/control/src/control-rpc.ts` requires global application management for creation and app-scoped management for updates. Human console creation avoids giving the daemon global authority.
- ⚠ `packages/control/src/api/registry/environments.ts` preserves some omitted placement fields and clears others. Builder updates must explicitly preserve the reviewed placement.
- ⚠ The local compiler executes application TypeScript and temporarily modifies its process environment. Compilation must run separately from credential-bearing daemon operations.
- ⚠ An immutable commit reference does not snapshot the Control registry. Do not claim an immutable full-manifest deployment guarantee.

## Work units

### WU0 — Freeze the contracts and authorization design (M)

- **Problem.** Browser-to-builder pairing and non-secret project binding have no shared contract.
- **Verify first.** Inspect both IAM transports, existing issuance, Control creation, provider compilation, and local daemon callers.
- **Scope.** Specify pairing lifecycle, browser consent, local custody, initial placement handoff, CLI/daemon DTOs and ownership. Record the durable decision. Independently review before dependent implementation.
- **Acceptance / witness.** Every field has one owner; secrets never enter project metadata, browser state, compiler environment or logs; both IAM transports implement the same contract.
- **Touch points.** Contract packages, builder shared DTOs, package manifests, ADR and this sprint.

### WU1 — IAM authorization transactions (L)

- **Problem.** There is no public device-pairing protocol; existing admin key issuance requires IAM administration.
- **Verify first.** Delegated issuance and revocation tests; database capability and migration conventions.
- **Scope.** Short-lived pairing attempts, authenticated human approval, live delegation checks, single-use redemption, mandatory key expiry and issuer revocation. Both database/runtime compositions.
- **Acceptance / witness.** Wrong proof, denial, expiry, replay and concurrent exchange refuse issuance. Machine callers cannot approve. An app-scoped service key cannot exercise global or other-app authority.
- **Touch points.** IAM implementation, migrations, transports and focused tests.

### WU2 — Console connection flow (L)

- **Problem.** Application creation, placement and local authorization are disconnected.
- **Verify first.** Existing application create/update and namespace/source authorization behavior.
- **Scope.** Human creation/selection, explicit destination review, approval and revocation through existing authenticated boundaries. Return non-secret binding information without browser-to-loopback cross-origin writes.
- **Acceptance / witness.** Non-admin users with sufficient explicit permissions can connect; insufficient permissions refuse. Creation conflicts never silently become updates.
- **Touch points.** Control and dashboard, their tests and generated route registry.

### WU3 — Local custody, admission and deploy orchestration (L)

- **Problem.** The daemon has neither platform credentials nor a safe deployment lifecycle.
- **Verify first.** Real HTTP/WebSocket admission probes and disposable Git-repository tests.
- **Scope.** Exact local-origin admission, private user-level credential custody outside repositories, project registration, browser pairing client, isolated compilation, explicit environment creation/update, immutable pushed revision trigger, run polling and resumption.
- **Acceptance / witness.** Hostile origins fail before side effects; restart retains the connection; no credential reaches compilation or artifacts; repeat updates preserve placement; failed preparation never triggers a deploy; terminal commit matches the requested revision.
- **Touch points.** Builder daemon, shared local deployment implementation and focused tests.

### WU4 — Local CLI and UI (M)

- **Problem.** The builder cannot display or operate the installed application, and its application preview assumes port 5173.
- **Verify first.** Existing init/resume and HTTP client tests.
- **Scope.** Connect/status/disconnect/deploy operations, explicit preview URL, connection and run views, clear offline/error states, console links. Keep UI and CLI on the daemon HTTP boundary.
- **Acceptance / witness.** Old projects still open; repeated init does not rebind; a non-default preview works; offline fixtures cannot deploy; failed runs cannot appear successful.
- **Touch points.** Builder CLI and UI with disjoint test ownership.

### WU5 — Zerops stack and agent workflow (M)

- **Problem.** The catalog does not describe today's platform-managed Zerops application path.
- **Verify first.** Catalog dependency closure and public Zerops example.
- **Scope.** Supported Zerops preset, current authentication/configuration guidance, preview publication, first deployment and subsequent changes.
- **Acceptance / witness.** Catalog integrity passes and workflow instructions match actual CLI help and implementation.
- **Touch points.** Builder stacks, decisions, skill and catalog tests.

### WU6 — Integrated verification and documentation (M)

- **Problem.** Unit doubles cannot establish the proxy/IAM/Control/browser round trip.
- **Verify first.** Available Docker stack and CPU leases; preserve unrelated running services.
- **Scope.** End-to-end local witness, independent reviews, root quality checks, UI builds, package validation, current reference docs.
- **Acceptance / witness.** Browser approval → local credential → first environment/deploy → repeat update, including denied and revoked access. Distinguish emulator success from real Zerops evidence.
- **Touch points.** Integration/browser tests, local test support and documentation.

## Out of scope (explicit)

- Remote coding-agent hosting and workspace management: the user explicitly prefers local agents.
- Namespace provisioning, GitHub App setup and custom-domain binding from the builder: the administrator prepares these.
- Automatic commits or pushes of application repositories: deploy consumes a remotely available commit.
- New global authorization semantics, an app-and-environment scope intersection, or a second gate evaluator.
- Production deployment, publishing and pushing this repository. Live Zerops testing needs separate authorization.
- Immutable registry snapshots for queued deploys; do not overstate the existing exact-source guarantee.

## Decisions

- [ADR-0042](../decisions/0042-connect-local-builders-through-human-consent.md) records local execution, human consent, credential custody and Control receipt ownership.

- The user approved browser pairing and human console confirmation of application creation/selection.
- The user approved orchestration, independent review, local integration checks and atomic commits on the current branch.
- Builder credentials use a separate service principal scoped to one app, with existing `app.manage`, `deploy.trigger` and `deploy.read` actions. `app.manage` also permits deletion and management of all app environments; consent must say so.
- Credentials remain outside the repository and outside browser/agent/compiler data. `fabrika control` keeps its environment-only credential contract.
- Protocol details and frozen DTOs are settled in WU0 before dependent implementation. Architectural blockers return to the user.

## Sequencing

WU0 first; local admission is an independent prerequisite within that wave. Then IAM, daemon foundations and catalog can proceed independently. Control consent follows the IAM seam. CLI and UI follow the local seam. WU6 integrates and verifies all units. Maximum three simultaneous implementers, one tree, strictly disjoint write territories. Each implemented unit receives review by another agent and leader-run checks before commit.

## Run log

- 2026-09-23: Completed native macro admission, including transitive file modules and executable data URLs. The user approved the single compatibility assertion for Bun's incomplete `TranspilerOptions` declaration; a root-only dependency patch would not protect public-package consumers. Final Builder suite and full repository typecheck pass. Stopped the owned PostgreSQL container; the owned browser session was already closed. No unrelated Docker services or networks were changed.

- 2026-09-21: Leader cross-plane witness passed (1 test, 33 assertions): non-admin human approval through real IAM/proxy/Control, two complete `runControlJob` executions with exact pushed revisions and preserved changed placement, other-app denial and fresh-mint rejection after human revocation. The provider is a deterministic test double; this is not real Zerops, Caddy networking, or browser evidence.

- 2026-09-21: Leader verified the deployment lifecycle fix with 31 tests/152 assertions and built the local Builder dashboard. The CI-pinned MinIO image could not be pulled (`pull access denied`); S3-backed tests remain unverified. The disposable PostgreSQL fixture remains available. Root lint exits zero with 16 pre-existing warnings outside the changed lines.

- 2026-09-21: Console consent and generated public gates landed as `c6ca94f`; CLI and connected-preset guidance as `883e9f7`; local platform/preview UI and isolated Builder test execution as `ad10beb`. Leader checks: dashboard 17 tests/169 assertions and production build; CLI 23 tests/210 assertions; UI 15 tests/44 assertions. Reviews found and corrected retry recovery, pending repeated init, and project-switch state retention.
- 2026-09-21: Combined Builder failures were reproduced as Happy DOM global contamination (`WebSocket` and `AbortSignal`), not daemon admission regressions. `--isolate` follows the existing agent-interface suite convention. Cross-plane integration tests belong to Control's existing runtime test program to avoid importing Cloudflare ambient requirements into Builder.

- 2026-09-21: The user explicitly deferred active-run credential recovery: if custody expires or is revoked while a run remains active, preserve the run/reservation and document the blocked state; do not add reconnect/reset behavior in this change. Unknown submission without a recorded run ID similarly remains fail-closed. Both limitations are stated in the local-builder reference.

- 2026-09-21: Grounding completed by three read-only agents; initial working tree clean at `c154865`.
- 2026-09-21: `bun run release:validate --tag=v0.2.0` passed for 28 public packages. Bare validation requires an explicit tag when HEAD is untagged.
- 2026-09-21: Baseline builder test command timed out waiting for a CPU lease; no test result was produced. Retry under a lease during verification.
- 2026-09-21: User approved the implementation gate. Protocol and console bootstrap specification review started; daemon admission implementation has a separate three-file territory.
- 2026-09-21: Independent protocol review accepted the design with conditions incorporated below: public fragment-capture bootstrap, creator-bound Control receipt, fresh IAM permission resolution, atomic issuance and issuer-visible recovery.
- 2026-09-21: Local admission landed as `214cda7` after independent review and a default-port normalization fix. Leader verification: 8 real HTTP/WebSocket/helper tests, 116 assertions, focused lint/format and leased builder typecheck passed.
- 2026-09-21: Zerops catalog landed as `a35615c`; independent review clear, leader catalog checks passed (5 tests, 378 assertions). Final agent command guidance awaits the CLI.
- 2026-09-21: Builder shared DTOs are implemented and independently reviewed without findings. Leader shared tests passed (7 tests, 46 assertions); commit awaits the Control receipt export dependency.
- 2026-09-21: The initially queued builder suite eventually ran with admission changes: 105 tests passed. This is an early integrated checkpoint, not proof of the new pairing/deploy flow.
- 2026-09-21: A disposable PostgreSQL 17 test container `fabrika-builder-pg-f3bb8251` is available on loopback port 32776 for the database witnesses. It is separate from existing services and must be stopped at closeout.
- 2026-09-21: IAM pairing landed as `b36799a`; Control receipt/consent and shared local DTO seams landed as `693213d`. Both received independent reviews without findings. Leader backend verification passed 1,218 tests across 111 files with real PostgreSQL, plus typechecks for auth-core/auth/IAM/Control-contract/Control and Operations. Two exact migration-history expectations were updated after read-only triage; their original backfill/upgrade witnesses passed unchanged.
- 2026-09-21: Shared runtime publication was verified with npm pack dry-run: both runtime modules included, test sources excluded. Release validation passed for 28 packages. Console authorization UI is implemented and under independent review; local CLI/daemon/UI integration remains active.
- 2026-09-21: `local:up` built the console, then Docker refused to create `fabrika-local_platform`: its default address pools are exhausted. The user explicitly approved completion without the real browser test. Do not alter unrelated Docker networks. Cross-plane in-process integration still forms part of WU6; a browser/proxy/login witness remains unverified.
- 2026-09-21: Console review found two recovery-state defects after confirmed rejected writes. The fix preserves uncertain/saved selections, permits explicit correction only after confirmed absence, and passed 17 leader-run tests (169 assertions).
- 2026-09-21: Installation generation check exposed a stale committed proxy template after the new public bootstrap/discovery gates. Regenerated through the owner command; the diff contains exactly those two gate entries. Generation check and nine local/Cloudflare gate-composition tests passed.

## Frozen technical seams

### Installation discovery and browser bootstrap

Control exposes exactly `GET /.well-known/fabrika-builder` publicly, returning `{version:1,controlOrigin,iamIssuer,provider}` from configured origins and the composed provider. No credential or request-header-derived origin is returned. The local client accepts HTTPS, or HTTP on loopback/`.localhost` development origins, validates the response, and pins the installation for the attempt. Credential-bearing fetches refuse redirects.

Exactly `/builder/connect` is a public, self-contained bootstrap page. It captures `#attempt=<id>&approval=<verifier>&expires=<unix-seconds>` into tab-local sessionStorage, immediately strips the fragment, then navigates to a protected console route `/builder/authorize`. It loads no external script or analytics before capture. Storage failure, expiry, malformed or missing parameters fail closed. The protected page resumes from sessionStorage; it never copies the proof into a login redirect query. Proof state is cleared after approval, denial or expiry. Existing proxy login and same-origin administrative admission remain authoritative.

### IAM device authorization

Public POST endpoints: `/auth/device/start`, `/auth/device/poll`, `/auth/device/exchange`, `/auth/device/cancel`. Require bounded JSON, no-store responses and no cookie-derived authority. Start admits only configured console audiences, with a bounded action list. Control additionally requires exactly `app.manage`, `deploy.trigger`, `deploy.read`, audience `vozka`, and an application scope. The builder requests 30 days; IAM caps at 30 days and fixes attempt TTL at 600 seconds. Local code generates separate 32-byte approval/redemption verifiers; start sends only S256 challenges. Attempt IDs are UUIDv7.

Shared types in auth-core:

```ts
interface StartDeviceAuthorizationInput {
	app: string
	label: string
	permissions: string[]
	keyLifetimeSeconds: number
	redemptionChallenge: string
	approvalChallenge: string
}
interface DeviceAuthorizationStarted {
	attemptId: string
	expiresAt: number
	pollIntervalSeconds: 3
}
interface DeviceAuthorizationProof {
	attemptId: string
	redemptionVerifier: string
}
interface DeviceAuthorizationConsent {
	consentId: string
	app: string
	label: string
	permissions: string[]
	scope: Scope
	keyExpiresAt: number
}
interface DeviceAuthorizationReceipt {
	attemptId: string
	consent: DeviceAuthorizationConsent
	credentialId: string
	principalId: string
	issuedAt: number
	revokedAt: number | null
}
type DeviceAuthorizationStatus =
	| { status: 'pending'; expiresAt: number }
	| { status: 'approved'; consent: DeviceAuthorizationConsent }
	| { status: 'issued'; receipt: DeviceAuthorizationReceipt }
	| { status: 'denied' | 'cancelled' | 'expired' | 'authority_lost' }
interface ExchangeDeviceAuthorizationInput extends DeviceAuthorizationProof {
	consentId: string
}
type ExchangeDeviceAuthorizationResult =
	| { ok: true; token: string; receipt: DeviceAuthorizationReceipt }
	| { ok: false; reason: 'already_issued'; receipt: DeviceAuthorizationReceipt }
	| {
		ok: false
		reason:
			| 'invalid_attempt'
			| 'pending'
			| 'denied'
			| 'cancelled'
			| 'expired'
			| 'authority_lost'
			| 'consent_mismatch'
	}
interface DeviceAuthorizationCaller {
	app: string
	credential: string
	requestId: string
}
interface InspectDeviceAuthorizationInput extends DeviceAuthorizationCaller {
	attemptId: string
	approvalVerifier: string
}
interface DeviceAuthorizationRequest {
	attemptId: string
	app: string
	label: string
	permissions: string[]
	keyLifetimeSeconds: number
	expiresAt: number
}
interface ApproveDeviceAuthorizationInput
	extends InspectDeviceAuthorizationInput
{
	scope: Scope
}
interface ListOwnDeviceAuthorizationsInput extends DeviceAuthorizationCaller {
	before?: string
	limit?: number
}
```

IamRpc adds `inspectDeviceAuthorization`, `approveDeviceAuthorization`, `denyDeviceAuthorization`, `listOwnDeviceAuthorizations`. Both runtime transports and the SDK HTTP client implement them together. Results follow existing `{ok:true,...}` / `{ok:false,reason}` conventions; request/consent/page fields are named `request`, `consent`, and `{items,nextCursor}` respectively. Private management methods require a verified active human of the requested console audience. Resolve LIVE audience permissions; neither `resolveCaller`'s JWT snapshot nor Control's bootstrap override satisfies this contract. Original-issuer listing/revocation does not require retained application grants.

Approval is immutable and idempotent only for the same approver/scope/authorization. Polling never issues a key. Exchange takes the exact consentId observed by the daemon and resolves the active approver and current permissions again. One repository capability owns an atomic batch: conditional approval claim, guarded service-principal insert, grant insert, hash-only credential insert, audit insert and issued-receipt finalization. Every write uses the same fresh claim ID; final UPDATE RETURNING establishes the winner. No read-modify-write or separate finalization. Live authority is freshly resolved, not globally serialized against concurrent grant edits.

Wrong proof is indistinguishable from unknown attempt and changes no state. Enforce a 3-second polling window via a proof-validated conditional update. Reuse the existing atomic password rate-limit repository primitive with a separate device-start purpose and the composition-root trusted client coordinate; never infer forwarding headers. Bound requests without a trusted coordinate with an installation-wide start bucket.

Issued-state recovery precedes attempt expiry checks. A lost exchange response yields only the receipt, never another key. List receipts issued by the authenticated human with revocation status; reuse revokeKey with the original human as issued_by. Retain issued receipts until key expiry plus one day; expired unissued attempts need no long retention. Both migration histories, SQLite concurrency/rollback tests and real Postgres tests are required.

### Control receipt and approval binding

`BuilderConnectionEnvironmentDto` has explicit `{env,namespaceId,domain,publicOrigin,triggerRef}` fields; all but env are nullable. `BuilderConnectionReceiptDto` has `{version:1,attemptId,provider,app:AppDto,environment,createdAt}`. Store creator principal ID internally, not browser-supplied. A unique insert owns immutability; identical creator/selection retries return the original, different reuse returns 409. Cascade receipts on app deletion. A receipt is neither authorization nor a resource reservation.

`builderConnections.createReceipt` is human-only, takes `{attemptId,approvalVerifier,appId,environment}`, verifies the approval proof via IAM inspect, validates the exact builder audience/actions and current app permissions, reads the app snapshot server-side, and persists creator identity. New placement uses the human's existing namespace.manage; existing placement must match the live row. No provider mutation or environment creation occurs. `getReceipt({attemptId})` resolves the stored app before app-scoped app.manage authorization and returns 404 for inaccessible records.

Control `builderPairing.inspect/approve/deny/listOwn/revoke` use the existing protected RPC. Approve takes `{attemptId,approvalVerifier}` ONLY: load the receipt, require its creator to equal the verified human, derive app scope from the stored receipt, and call IAM. Never trust a browser-supplied app on this step. Revoke forwards the human credential to existing revokeKey and remains available after application permission removal.

The console creates the bare app with existing apps.create before the receipt; source repo must already exist. Persist receipt BEFORE approving IAM. Partial failure leaves an explicit recoverable app/receipt, not an automatic deletion or implicit rebind. After redemption the daemon fetches the receipt at the original Control origin with its app-scoped key. A mismatched IAM scope/receipt is a failure.

### Local API and deployment

Builder shared DTOs live under `packages/builder/shared/`, included in the published package. Endpoints are `POST /api/project/:id/register`, `GET /api/project/:id/platform`, and POST suffixes `/connect`, `/disconnect`, `/deploy`, `/preview`. CLI and UI import these shared contracts, never daemon implementation. Registration works independently of canvas revisions. Config retains old profile/sessionId/createdAt and adds only a non-secret connection and optional preview URL.

Credential storage is separate from sessions/artifacts and outside every registered project root, with private directory/file modes and symlink refusal. Pin credential origin independently of mutable project JSON. Config edits cannot redirect a retained key. Disconnect removes local custody and clearly directs the user to console revocation; it must not claim deletion revoked the server credential.

Compilation runs a short-lived Bun process using the existing Zerops compiler, with an explicit environment allowlist excluding platform credentials, and writes its result outside the project. Validate Git root, tracked descriptor/config, clean source and remotely available full HEAD before remote writes; recheck after compilation. Never commit or push. First environment uses receipt placement; updates read the current environment and preserve all placement/trigger fields explicitly. Refuse unexpected app repository/provider identity changes. Serialize local app/environment operations, trigger exact SHA and compare the completed run's commitSha. Preserve run ID across restart. A successful run exposes configured app URL without claiming URL reachability was separately tested.

### CLI and local UI

New commands remain under `fabrika builder`: `connect --url=<control-origin>`, `status`, `disconnect`, `deploy [--wait] [--timeout=<seconds>]`, and `preview --url=<url>` or `preview --clear`. Support `--json` for machine-readable sanitized results; progress and errors do not corrupt stdout. `connect --no-open` prints the local dashboard address rather than the approval proof. CLI registration uses the absolute project root and configured session ID. A successful trigger is not completion; `deploy --wait` exits nonzero on failure, cancellation or timeout, retaining the run ID for inspection.

`init --url=<origin>` initializes the supported connected Zerops profile by default for a NEW project, registers the project with the daemon and begins pairing. Explicit profile and existing-project behavior must be validated; repeat init never silently replaces the profile or binding. `init --no-daemon` remains usable offline, but cannot also connect. Plain init retains its existing default. Shared config parsing replaces the lossy three-field parser; malformed existing config must not be overwritten. Agent task packets include the selected provider/app/environment and non-secret placement context so generated code matches the connection.

The local deployment panel owns connection and deploy status, consent navigation, local preview configuration, errors and console/app links. It uses the shared parsed HTTP boundary. Never expose a Control client, key or redemption proof in the browser. Disable mutating controls in fixture/offline mode. Remove arbitrary daemon-origin overrides from privileged requests. Replace the hardcoded application preview port with the configured URL and an explicit unset state. Follow the existing builder visual conventions; no wholesale redesign.
