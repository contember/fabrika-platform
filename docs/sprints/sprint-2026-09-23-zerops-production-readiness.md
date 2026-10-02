# Sprint — Prepare a production-ready Zerops release (2026-09-23)

**Goal.** Prepare a verified Fabrika release for a small internal application fleet on Zerops, with repeatable deployment, real authentication, and demonstrated recovery.

**Theme.** Close the defects that can invalidate a deployment or its trust boundary, then rehearse the complete selected installation. A passing unit suite is not a production-readiness verdict.

## User requirements

- Small internal fleet, one organization; planned short outages are acceptable.
- Prepare the release in this run. Production publication and deployment require a separate confirmation.
- Select the production topology after candidate resource measurements, and approve its cost before provisioning it.
- Password and OIDC authentication are both required.
- Automatic source-map publication from Zerops builds and original-source stack frames are required (backlog 36). Webhook notifications are required; email notifications are deferred.
- Preserve acknowledged database writes through a single-node failure. For accidental deletion or loss of an entire project, restore within four hours from the last verified complete backup, no older than 24 hours. Point-in-time disaster recovery is not required.
- Existing `fabrika-test` in `prg1` is the disposable live-test project. Its stopped `envprobe` holds only synthetic release/DSN labels. It is not a platform installation.

## Refs re-verified at HEAD (2026-09-23)

Baseline: `4bb81292780b36115e5e6352b53be250de2d7a99`, local `main`, 31 commits ahead of the local `origin/main` ref. Remote CI metadata has no run for this exact SHA.

- ✔ Managed deployment configuration contains release, IAM issuer and the Operations keys, with `null` meaning removal — `packages/control/src/run-lifecycle.ts:433–460`.
- ✔ Zerops mutates those canonical service variables before entering the deploy engine, then passes an empty managed environment to it — `packages/provider-zerops/src/control.ts:513–559`.
- ✔ Live failed/cancelled-build, restart and rollback observations contradict transactional activation — [platform witness](../reference/zerops-platform.md#verified-live-2026-09-23-account-prg1--service-variables-across-activation-and-rollback).
- ⚠ Deploy locking is TTL-bounded and holder-checked, without renewal in the SQL implementation — `packages/platform/src/deploy-locks-sql.ts:54–69`. The activation protocol must not assume indefinite exclusion or exclusive reconciliation.
- ✔ The sidecar checks out its selected tag but supplies an independent build-source URL — `packages/installation-zerops/src/templates/platform.yml:76–81,123–128`.
- ✔ Descriptor validation uses Bun YAML parsing, while the provider sends the original descriptor to Zerops — `packages/provider-zerops/src/manifest.ts:251–255`, `packages/provider-zerops/src/provider.ts:505`.
- ✔ Operations webhook dispatch uses ordinary fetch after target syntax validation — `packages/operations/src/maintenance.ts:114–130`; DNS-pinned egress is not established by this check.
- ✔ The local Docker composition is running with healthy IAM, Control, Operations, PostgreSQL, SeaweedFS, source and auth services. Browser scenarios use a separate resettable composition — `tests/browser/README.md:28–43`.
- ⚠ Existing browser scenarios principally cover Operations and seeded-session handoffs, not the complete password/OIDC/Builder lifecycle — `tests/browser/README.md:45–59`, `docs/reference/local-builder.md:68–71`.

External documentation checked on 2026-09-23, **not live HA verification**:

- [PostgreSQL profiles](https://docs.zerops.io/postgresql/how-to/scale) describe synchronous HA for OLTP/WriteHeavy and asynchronous HA for OLAP.
- [PostgreSQL backups](https://docs.zerops.io/postgresql/how-to/manage#backups) are per-schema custom-format `pg_dump` files, not a documented WAL/PITR service.
- [Backup handling](https://docs.zerops.io/features/backup) requires service-specific restore and documents a seven-day grace period after project deletion.

## Proposed production topology

Keep the platform and applications in separate projects. Use PostgreSQL HA with an OLTP profile for authoritative platform/application data. A small-fleet profile does not need a high traffic floor, but single-container hobby PostgreSQL does not satisfy the agreed node-failure requirement.

Use the existing supported topology where possible; do not introduce a new installation preset without approval. Decide profile, namespace database sharing, project core tier and resource caps before data is written. Verify the cost and selected shape before creating HA test resources. The existing LIGHT test project does not dictate production sizing.

## Work units

### WU0 — Settle platform primitives and freeze contracts (M)

- **Problem.** The two delivery blockers rely on platform behavior not yet proven: code/config binding and immutable public build revisions.
- **Verify first.** Use synthetic values in disposable services. Probe version-scoped secret references, initialization visibility, failure/cancellation/restart/rollback, canonical-key collision and absence semantics. Probe non-default tag and exact SHA source selection independently of the default branch.
- **Scope.** Select the smallest supported activation and revision protocols, inspect all callers, record the architectural decision, and land any shared contract/checkpoint changes before implementation territories split. Confirm the selected HA profile's actual replication configuration and plan its failure witness.
- **Acceptance / witness.** Process-visible code/config pairs remain matched throughout the tested lifecycle; source identity is measured from the built artifact, not inferred from request acceptance. Unproven cases remain blockers. Secrets never enter artifacts, checkpoints, logs or project env.
- **Touch points.** Leader-owned `docs/decisions/`, platform facts/reference, shared contracts and narrowly identified composition seams. Disposable fixtures outside the repository. No production implementation is authorized by a failed probe.

### WU1 — Durable managed-environment activation (L; backlog 37)

- **Problem.** Failed candidate variables can reach old code on restart; sequential writes can leave a partial set.
- **Verify first.** WU0's live primitive and migration/absence behavior; control lease/reconciliation races.
- **Scope.** Bind all platform-managed deployment keys to a specific version; preserve ordinary application-secret semantics. Recover the same binding after interrupted staging, lost responses, cancellation and Control restart. Prevent older/concurrent work from corrupting a newer binding.
- **Approved boundary.** Use immutable version-scoped service values and descriptor references for new applications. Refuse automatic conversion of legacy canonical configuration before mutation; legacy migration is a separate, explicitly designed operation. The user approved this boundary after comparing native pipeline configuration with version-scoped references.
- **Decision.** [ADR-0044](../decisions/0044-bind-zerops-managed-configuration-to-application-versions.md) records the binding and recovery contract, including collision-safe first provisioning approved by the user.
- **Acceptance / witness.** Fault-injection tests at each durable boundary, duplicate delivery and concurrent reconciliation, a run longer than the current lease, and live failed-build/restart/rollback pairing. No secret values in durable provider envelopes or logs.
- **Touch points.** Provider deploy/control/checkpoints/API and their tests; Control lifecycle/reconciliation and any approved lock changes. This is one combined territory, not separate agents editing either side of the same protocol.

Implementation contract to freeze before delegating:

- Establish a create-only protocol/ownership marker only during fresh provisioning. An existing unmarked service is not automatically adopted, even when its canonical variables appear absent.
- Creation must be positively attributable to the provisioning operation; a pre-import absence check alone is not evidence because `override` can adopt a concurrently created service. Wait for import processes before any marker write.
- A subsequent deploy admits the previous coherent version binding, including explicit absences. Canonical records may be returned as `USER` even when they contain descriptor references; classify by the exact owned binding, not the record type alone. Do not treat markers as protection against privileged platform edits.
- Reserve the internal secret-key prefix against application writes. Stage values with create-only writes and exact in-memory read-back; checkpoints contain only coordinates, original artifact/descriptor digests, setup, reference names and confirmed record IDs.
- Recovery never regenerates values from the current catalog. An incomplete unconfirmed staging set fails safely before submission. Once submission may have happened, observe the frozen external version rather than retrying submission or declaring terminal failure from a local timeout.
- Use a renewable invocation lease with unique attempt holders, durable exclusion of newer runs while external work remains unresolved, and fenced compare-and-swap checkpoint/terminal writes. Deploy, reconciliation and cancellation share this discipline. The existing 30-minute TTL alone cannot cover a 70-minute build.
- Repository mutations must serialize on the common lease row while checking ownership, sibling runs and prior checkpoint. A standalone PostgreSQL `NOT EXISTS` or lease `EXISTS` predicate is insufficient. Losing an invocation lease stops effects; it is not a request to cancel the external build.
- Cancellation request acceptance is not external settlement. Retain staged secrets for rollback; do not claim a cancelled run restored old code if activation already won.
- Shared seams include lock renewal, guarded run-repository mutations, unresolved provider outcomes and reconcile/cancel signals. Land and review those together before provider implementation; preserve Cloudflare behavior in mechanical contract updates.

### WU2 — Immutable installation and namespace-proxy revision (M; backlog 65)

- **Problem.** A pinned pipeline can still build a different service revision.
- **Verify first.** WU0's non-default tag/SHA observations.
- **Scope.** Bind every installation service and newly provisioned or republished namespace proxy to the selected immutable source. Specify what happens to existing persisted namespace targets; never silently infer that a new default migrates them.
- **Acceptance / witness.** Repeated deployment of the same selected release builds identical source despite a different default-branch tip. Upgrade preserves app proxy entries, stored data and credentials.
- **Touch points.** `packages/installation-zerops/`, revision-specific CLI/provider namespace plumbing and tests, `packages/control/src/node/zerops-proxy.ts`. Provider namespace signatures and shared generated artifacts are frozen in WU0 before concurrent work.

### WU3 — One validated YAML interpretation (M; backlog 90)

Completed: `c5e917a` implements the strict subset and canonical execution descriptor. Focused tests,
pinned Go-reader witnesses and the 2026-10-02 live canonical-descriptor build passed. Backlog 90 is removed;
ADR-0043 and the platform reference retain the contract and live evidence.

- **Problem.** Validation and execution use different YAML readers and the original text crosses the trust boundary.
- **Verify first.** Reproduce tag, alias, duplicate-key and encoded-reference cases against both the local validator and a YAML-1.1/platform witness.
- **Scope.** Establish one supported descriptor interpretation at the input boundary. Preserve supported descriptors, source identity and foreign-service reference restrictions. Parser dependencies or descriptor-contract changes need approval.
- **Acceptance / witness.** Unsupported/ambiguous input is refused before registration/provider effects; encoded foreign references cannot bypass checks; valid descriptors still build. No regex-only claim of YAML equivalence.
- **Touch points.** `packages/provider-zerops/src/manifest.ts`, dedicated descriptor validation module/tests. Exported descriptor contract belongs to WU0 and cannot drift under WU1.

### WU4 — Safe Operations egress (M; backlog 38)

**Paused by user.** Native Bun 1.3.14 transports did not enforce the response-header bound. The user declined the proposed temporary npm Undici compatibility spike for now. The incomplete adapter was removed from the working tree; its eight-file draft is retained at `/tmp/opencode/fabrika-wu4-paused.patch`. This is an unresolved release blocker for the required webhook notifications and active checks.

- **Problem.** Syntax validation does not keep webhook/health traffic outside private networks after DNS resolution.
- **Verify first.** Inspect existing runtime transports and caller requirements. Prove the selected Bun transport can pin validated addresses while retaining hostname/TLS verification.
- **Scope.** Secure both webhook delivery and active HTTP health checks in the Zerops runtime. Preserve timeouts, redirect refusal, bounded response handling and stable delivery idempotency. Keep runtime-specific networking outside the portable kernel.
- **Acceptance / witness.** Private, loopback, link-local and IPv4-mapped IPv6 destinations are refused, including mixed answers and rebinding; valid HTTPS works with correct hostname verification. Real alert delivery/retry and health failure/recovery still work.
- **Touch points.** Operations outbound boundary, `packages/operations/src/node/`, necessary existing runtime adapter territory and tests. Any shared port or dependency addition belongs to WU0.

### WU5 — Zerops build artifacts and release evidence (M–L; backlog 36)

- **Problem.** The source-map receiver exists, but Zerops builds do not yet publish scoped artifacts automatically.
- **Verify first.** Inspect the existing upload credential, artifact format and source-map lookup contracts; establish a build-side credential-delivery path without persisting secrets in manifests or logs.
- **Scope.** Publish source maps from where Zerops build artifacts exist, using a run/release-scoped credential. Preserve deployment on artifact-publication failure, mark incomplete artifacts honestly and support repair. Retain run/release correlation in the protocol; new correlation UI is excluded.
- **Acceptance / witness.** Deploy a minified fixture through the actual Zerops path; ingest its error and resolve original source frames. Wrong application/environment/release credentials cannot publish or read another source's artifacts. Publication failure does not turn a successful application deploy into failure.
- **Touch points.** Build-side artifact publisher, provider/source integration, and Control/Operations artifact credential plumbing. Freeze shared provider contracts in WU0; serialize provider integration after WU1 where file ownership intersects.

### WU6 — Full candidate rehearsal and recovery evidence (L elapsed)

- **Problem.** Neither old CI nor deterministic providers prove current installation, authentication and recovery behavior.
- **Verify first.** Fresh test backend readiness, domain/IdP/private-source prerequisites, selected topology, generated artifacts and release packaging.
- **Scope.** Rehearse clean install, repeated upgrade, current-release public/private app deployments, keyed webhook, browser password and OIDC sign-in, scoped authorization, revocation, SDK ingest and triage, and Operations outage isolation. Test HA acknowledged-write survival and restore into an isolated target from a complete recovery set. Builder E2E is excluded.
- **Acceptance / witness.** Record exact source revisions and observed results. Recovery covers IAM/Control/Operations SQL including migration ledgers and queues, object payloads, and matching vault/signing/configuration secrets. Restored work cannot duplicate occurrences or accidentally dispatch stale notifications. After a roll, verify actual catalog/ingest convergence before accepting application deploys.
- **Touch points.** Leader-owned integration fixtures, browser acceptance, release/restore runbook and evidence. No production publication, DNS cutover or deployment. Test-sidecar pushes or publication require separate explicit confirmation.

## Proposed sequencing and ownership

The user approved the sprint, automatic Zerops source maps and webhook notifications. Architecture decisions remain gated on evidence. The completion order is to close the reviewed Delivery prerequisites, finish WU1/WU2 integration, then finish the remaining production requirements and rehearse one candidate. Do not open additional implementation workstreams while the shared Delivery integration remains unfinished.

1. WU0: leader drives live probes and shared contracts, with independent read-only review.
2. After decisions and exact file ownership are frozen: WU1, WU2, WU3 and WU4 may run concurrently, at most three implementers. If provider/descriptor files cannot be made disjoint, merge or sequence those units.
3. Each implementation receives independent review, leader-run verification and an explicit-path atomic commit.
4. WU5 integrates source-map publication after its shared deployment seams settle; new correlation UI is excluded.
5. WU6 exercises the integrated candidate. Findings return to their owning unit; acceptance is never weakened to make the candidate green.

Isolation: current branch and shared working tree; strictly disjoint implementation territories. The leader owns documentation, shared seams and generated integration artifacts. Existing unrelated work is preserved.

## Verification gates

- `cpu-lease run -n 4 -- bun run typecheck`
- Repository dprint and Biome checks; generated Zerops artifacts and frozen installation checks.
- Focused unit/integration regression checks, then full repository tests with real PostgreSQL and S3 configured, including isolated agent-interface/Builder suites.
- Dashboard and proxy production builds, release validation/pack/import smoke using a disposable version label. No registry publication.
- Existing browser suites plus the missing required login witnesses; no new Builder E2E gate. Local disruptive smoke only on its dedicated composition.
- Real Zerops capability, installation, upgrade, private-source and selected-topology/HA/restore witnesses. Local emulation cannot substitute for these.

## Explicit deferrals proposed for the gate

- Builder E2E and new Delivery/Operations correlation UI are excluded by user approval. Existing regression tests remain required.
- Cloudflare-only runner/account-token/DO/self-deploy items: not part of this Zerops milestone.
- Directory/groups (91), separate Operations host identity (54), one-command registration (78), one-click installation (63), old-token repair (75) for a fresh installation, and namespace resizing (79).
- Best-effort domain audit (71) is not a database-replication guarantee. Lossless audit needs a separate decision and is not silently promised here.
- Email Operations alerts (46) are deferred; the user selected webhook delivery. Automatic source maps (36) are required in WU5.
- Catalog lease/logging (84/85): proposed operational gate is measured convergence after maintenance; no claim of unattended immediate post-roll readiness.
- Claim-release/deletion policy remains deferred; existing claimed-environment deletion already answers 409 rather than the deterministic 500 described in backlog 87.

## Decisions still needed

- Approve the selected production topology after its cost/resource readout; the bounded release gate is approved.
- Finalize the approved version-scoped activation protocol's crash/concurrency contract and remaining live witnesses. Automatic legacy migration is not approved.
- Supply or select test domains, real OIDC provider configuration and the non-production private-source organization/repository through the existing secure setup flow. Never place their credentials in this document.
- Immutable installation and namespace source transport is settled by ADR-0045; complete its integrated acceptance rather than reopen transport selection.
- Select the source-map publisher's supported build runtime/distribution, scoped completion receipt and repair window. Existing upload credentials and receivers can be reused, but publishing maps alone does not prove a complete inventory.

## Run log

- 2026-10-02: User explicitly kept WU4 paused when asked whether to authorize an isolated npm Undici compatibility probe. No probe or dependency change is authorized; required webhook readiness remains blocked while Delivery completion continues.

- 2026-10-02: Delivery prerequisites committed: raw environment observation (`676cdab`), managed-binding helpers and manifest policy (`f5d4a74`), shared run/namespace ownership and retained lookup (`5c01205`), installation namespace defaults (`2c105e8`). Independent re-review closed all three namespace findings. Leader verification: 58 helper/manifest/lookup tests, 90 API/proxy tests, 372 lifecycle tests, 108 adapter tests, 11 real PostgreSQL fencing tests and 81 affected installation tests passed. Affected package typechecks and scoped formatting/lint passed (lint reports informational index-access suggestions). Full #37 runtime integration resumed; these prerequisites do not establish its acceptance or full candidate installation.

- 2026-10-02: User approved completion with Builder E2E and new correlation UI excluded. Close the current Delivery integration before starting another implementation workstream. Production topology remains measurement-led; complete-backup freshness is at most 24 hours and restore time at most four hours. WU4 remains paused pending its explicit transport decision.

- 2026-10-02: Live source pipeline upload/extraction passed using an explicit probe descriptor: pinned Git bytes and relative symlinks matched at runtime. Service stopped and verified; → platform reference/manual fact row. Full platform descriptor installation remains a separate gate. The immutable bootstrap-marker amendment passed independent review (34 helper tests).

- 2026-10-02: Live managed bootstrap probe confirmed codeless process/active-version identity and accepted a 63-character backing name. It disproved the helper's `SECRET` type assumption: sensitive API-created records are `USER` with `sensitive: true`. Parser/types and helper checks are being corrected; → platform reference. Probe cleanup finished.

- 2026-10-02: The stalled archive witness was isolated to Bun's stream-backed `Response` file consumer. Explicit-reader and production-style gzip/native-fetch witnesses completed for the public pinned commit; → platform reference. No production workaround was added. Managed-binding helpers passed 27 leader-run tests and independent review; runtime wiring remains pending.

- 2026-10-02: Ownership re-review closed all four findings. Leader ran 77 lifecycle/fencing/recovery tests with real PostgreSQL and no skips. Source-service, installation and Control package typechecks subsequently passed after the namespace attempt public exports were connected. Scoped retained-checkpoint lookup passed three tests and independent review. The public source-archive witness stalled while consuming its stream and remains unverified; diagnosis is separate from the passing mocked source tests.

- 2026-10-02: Fresh creation provenance was verified with a disposable collision-rejecting import: returned and finished creation processes preserve exact service/process identity. The probe service was deleted; evidence is in the platform reference/manual fact row. Managed-binding primitives are being implemented; scoped historical lookup and runtime wiring remain separate.

- 2026-10-02: Leader reran the platform-source protocol/metadata/archive/service suites: 265 passes, 756 assertions, no failures; both independent reviews accepted the slice. Latest package typecheck reported only two namespace `Sleeper` typing errors outside source-service changes, assigned to the namespace integration owner. User authorized direct affected-package typechecks and focused verification suites while the CPU lease queue is blocked, excluding builds and benchmarks.

- 2026-10-02: User approved exact-version, app/environment-scoped lookup of retained run checkpoints for managed-binding admission after rollback. User also approved shared durable namespace proxy attempts and renewable ownership across every rebuild path; → ADR-0046. Both integration seams remain under implementation.

- 2026-10-02: Namespace provider review accepted the recovery fixes after the real API client preserved only verified `400 appVersionNotFound` during deletion. Leader ran 127 API/namespace tests (547 assertions), no failures. Installation default serialization now escapes `$` as JSON `\u0024`; independent re-review accepted exact descriptor/digest round-tripping. Remaining typechecks and source suites were resubmitted after the server restart.

- 2026-10-02: A disposable reservation established the exact `400 appVersionNotFound` response on GET and repeat DELETE after confirmed deletion; see platform reference and manual fact row. Namespace recovery is adopting this narrow absence evidence. Re-review also found an adoption/readiness regression, now assigned for correction before acceptance.

- 2026-10-02: Exact-checkout installation transport landed in `6ac64f5` after 237 leader-run tests, package typecheck, formatting/lint and independent review. The snapshot test's concrete ArrayBuffer type was corrected. Native upload/build evidence is recorded in the platform reference. Namespace integration and full installation acceptance remain open.

- 2026-10-02: Independent review found no defects in platform tar-link/protocol handling and ran 47 focused tests. Exact-commit Git tree preflight remains a separate review gate. The live installation witness proves native archive symlink extraction, not an end-to-end source-service platform upload.

- 2026-10-02: Namespace recovery must retain ambiguous `build_trigger_requested` checkpoints even when the version remains `UPLOADING`; a read-only draft suggested timeout cleanup, which contradicts ADR-0044 and was rejected before implementation. Populated legacy namespace pin migration is not part of fresh-install readiness; unpinned targets remain inspectable but refuse proxy mutation.
- 2026-10-02: Platform archive link support passed 222 focused author tests. Review remains pending. Marker-only submodule detection is insufficient for a platform archive; the source-service unit is adding bounded exact-commit Git tree validation rather than claiming `.gitmodules` proves completeness.

- 2026-10-02: Snapshot helper landed in `83943dd`. Native upload/build witness passed and probe stopped; exact blob bytes and relative symlink were checked at runtime (see platform reference/fact table). Installation transport re-review accepted both fixes, independently running 52 tests. Full installation/upgrade acceptance remains pending.

- 2026-10-02: Committed-source preparation passed 22 leader-run tests (49 assertions) and independent re-review after disabling Git checkout conversions in isolated archive attributes. Installation transport review fixes remove an obsolete init prompt and repair entrypoint coverage; all installation tests reported 237 passes. Native archive upload/build witness is running on a disposable probe; no platform installation was deployed.

- 2026-10-02: The approved installation/namespace source decisions are recorded in [ADR-0045](../decisions/0045-upload-immutable-platform-and-namespace-proxy-sources.md). Implementation and live archive acceptance remain in progress.

- 2026-10-02: User approved per-namespace immutable repository/commit/descriptor identity for provisioning, reconciliation and registry republish, using the existing source-service upload path with validated safe relative platform-archive symlinks. Legacy unpinned namespaces require an explicit pin; registry rebuild requests may wait for bounded upload before reporting started.
- 2026-10-02: Runtime integration found that Cloudflare runner cancellation swallowed container-destroy failures and did not exclude a delayed start. User approved a narrow runner-boundary correction with failure/ordering regression tests, preserving the detached runner architecture.
- 2026-10-02: Full typecheck executed after queued CPU capacity became available, during source/lifecycle signature changes, and failed on incomplete caller adaptations. This is an in-progress failure, not a verified repository gate; rerun after integration.

- 2026-10-02: User chose mandatory `--source-dir` for both installation bring-up and deploy; mutable Git-source installation builds must be refused. The preparation unit freezes one committed checkout archive; the transport unit reuses it across both install passes and all five service builds. Namespace proxy source remains a separate design gate.
- 2026-10-02: Run mutation fencing landed in `c603eb9`. Runtime integration uses explicit unresolved deploy/cancellation outcomes and distinguishes lease loss from user cancellation; provider contract signatures are frozen for that unit. The detached Cloudflare runner co-write remains independent of Control invocation ownership.

- 2026-10-02: Fenced run-write review found no defects under acquire-before-mutate, unique invocation holders and fresh per-call timestamps. Real PostgreSQL tests confirmed checkpoint CAS and takeover waiting behind the mutation transaction; runtime adoption remains pending. Collision-safe provisioning landed in `f44d1af`.

- 2026-10-02: User approved exact-checkout archive upload through the existing Zerops reserve/upload/build API for installation CI. Namespace proxy source ownership still needs its corresponding design before implementation.
- 2026-10-02: Collision-rejecting application registration passed leader-run 100 tests, provider typecheck, formatting/lint and independent review. Fenced repository writes passed 65 leader-run tests including all six real PostgreSQL cases; lifecycle integration remains pending.

- 2026-09-28: Lease renewal landed in `2e2a2a5`; runtime integration remains pending. User approved collision-rejecting initial provisioning. Live import with `override: false` refused an existing name, including a mixed new/existing document without creating the new service. The existing service remained stopped.

- 2026-09-28: WU1 lease-renewal primitive passed independent review and leader-run SQLite/Postgres tests: 46 passed, none skipped. Runtime heartbeat and fenced repository mutations remain separate integration work.
- 2026-09-28: Version-reference cancellation witness passed on live Zerops: candidate reached `CANCELLED`; after restart, code A and init retained A values. Probe stopped again. The reference and fact table record this manual witness.
- 2026-09-28: Pre-implementation review tightened WU1 admission: canonical descriptor references can appear as USER records; fresh provisioning needs positive creation evidence; durable run admission must serialize against lease takeover inside the repository operation.

- 2026-09-23: User selected small internal fleet, both password/OIDC, and prepared-release-only scope. Near-zero loss was clarified as a single-DB-node failure guarantee; last verified backup is acceptable after deletion/project loss.
- 2026-09-23: Three independent read-only grounding passes covered activation, installation/delivery and Access/Operations. No implementation delegated.
- 2026-09-23: User approved the full sprint and per-unit verified commits, required automatic Zerops source maps, and selected webhook notifications. Independent read-only specifications now cover source pinning, the YAML boundary and egress while the leader probes version-bound configuration.
- 2026-09-23: Full repository typecheck passed. Release validation passed for all 28 public packages with disposable label `v0.2.1-zerops-readiness.0`; no tag created or package published. Calling validation without a tag first refused as designed.
- 2026-09-23: Earlier live #37 experiment is recorded in the platform reference/fact table. New facts are manually verified; existing emulator suite passed 41 tests but does not exercise those new runtime observations. `envprobe` is stopped.
- 2026-09-23: Subsequent version-reference probes passed failed-build/restart, successful activation, descriptor-key absence and rollback, including init commands. A legacy canonical-key conversion then rollback lost the canonical values. The user approved the new-application-only boundary in WU1; do not generalize these observations to untested cancellation, multiple containers or Control crashes.
- 2026-09-23: Native `envSecretsFile` experiments did not provide the required rollback binding; an extra secrets field on the upload build endpoint was ignored. These do not establish a supported atomic upload/configuration API.
- 2026-09-23: WU3 was implemented and independently reviewed. The review found an escaped U+FFFE/U+FFFF emission regression, now fixed. No WU3 commit has been made yet.
- 2026-09-23: WU4's draft and a separate runtime investigation found native header-limit failures. User paused WU4; no npm transport dependency was added. The working tree no longer contains its runtime wiring or draft tests.
- 2026-09-28: Leader verification passed 253 focused WU3 tests (825 assertions) and 10 corpus witnesses against both pinned Go YAML readers. This is not a live Zerops canonical-descriptor witness or full-repository acceptance.
- 2026-09-28: WU3 committed as `c5e917a` after independent review and leader checks: 559 provider/emulator tests passed, 37 opt-in live tests skipped, full typecheck passed, formatting passed, repository lint exited successfully with 16 warnings and informational diagnostics. ADR-0043 records the approved descriptor contract. Backlog 90 remains open until its live acceptance gate is complete.
- 2026-09-28: Fresh-service SHA suffix probe also built default-branch bytes. Reference and manually verified platform-fact rows now record the source-selection and configuration observations. All five disposable runtime probes were stopped; the test project's core remains running.
- 2026-09-28: Exact-SHA `buildFromGit` on the previously initialized `pinprobe` still built default-branch content: process `U2Cn2uFbSq2EgxQw7hPYgw`, requested `829753baf1ba04c8907b16c91d6f4db890e18e43`, observed package hash `50b56ac7caa1fc92e11529d1d655221c3c84f519c4d532aeb00b4e56215b205c`. Earlier repeated tag selection did the same. The field is documented as first-build initialization: these observations prove neither fresh-service suffix behavior nor a supported revision-update operation. Keep #65 open and verify those separately.
