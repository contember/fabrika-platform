<!--
On close, prepend an OUTCOME block here, then `git mv` this file to ../archive/:

> **OUTCOME — shipped YYYY-MM-DD.** <one-paragraph result.> Commit map: WU1 → <sha>,
> WU2 → <sha>, … Verification: <the gate command + numbers>. Backlog closed:
> <ids deleted/rescoped>. Deferred: <honest notes>.
-->

# Sprint — Auth boundary cleanup (2026-07-31)

**Goal.** Make the proxy the only path-gate enforcement point and make the remaining IAM schema reconcile step honour deploy cancellation.

**Theme.** The proxy extraction left two copies of gate semantics, an app SDK that can still enforce the retired in-process path, and one provider-neutral HTTP step that drops the run's abort signal. These are one boundary-cleanup batch: the proxy admits a request, the app verifies the injected identity for object authorization, and deploy collaborators receive cancellation end to end. This sprint consumes backlog items 17, 18, and 19.

## Refs re-verified at HEAD (2026-07-31)

- ✔ `@fabrika/auth` still exports `PropustkaAuth` and the gate-oriented `AppGates` surface, even though the proxy is the enforcement point — `packages/auth/src/index.ts:31`.
- ✔ The old SDK session path still owns matching, credential extraction, session/key minting, token cookies, login redirects, and JWKS caches — `packages/auth/src/session.ts:75` and `packages/auth/src/session.ts:298`.
- ✔ The proxy carries a second path matcher and second credential readers with an explicit duplication warning — `packages/proxy/src/gates.ts:11`.
- ✔ The injected token header is defined in the proxy and duplicated by the Zerops example; a cross-package test only detects drift after the fact — `packages/proxy/src/constants.ts:7`, `examples/zerops-app/src/authz.ts:30`, and `packages/installation-zerops/zerops/__tests__/example-app.test.ts:345`.
- ✔ The SDK already has the load-bearing constructor that turns verified access claims into an `AuthContext`, including object authorization and audit attribution — `packages/auth/src/client.ts:69`.
- ⚠ Control and Operations still call the gate-enforcing `authMiddleware`, while the Cloudflare example constructs `PropustkaAuth` directly. All three are first-party migration witnesses, not dead test-only code — `packages/control/src/iam.ts:134`, `packages/operations/src/app.ts:66`, and `examples/app/src/app.ts:16`.
- ✔ The Zerops example already demonstrates the intended post-proxy division of labour: read the injected header, verify signature/issuer/audience, then perform object authorization locally — `examples/zerops-app/src/authz.ts:1` and `examples/zerops-app/src/authz.ts:84`.
- ✔ `SchemaReconcileInput` has no signal, both providers assert that the run is still active immediately before reconciliation, and then call a collaborator that cannot cancel its `fetch` — `packages/provider-contract/src/schema.ts:3`, `packages/provider-cloudflare/src/provider.ts:120`, `packages/provider-zerops/src/provider.ts:225`, and `packages/auth/src/provision.ts:55`.
- ⚠ The named downstream apps still use predecessor packages and in-process authentication, but their repositories have independent uncommitted or unpushed work. The Fabrika sprint can specify their migration without editing those worktrees — `docs/backlog/18-shrink-the-app-sdk.md:39`.

## Work units

### WU1 — Establish one gate and token wire contract (effort M)

- **Problem.** Gate matching and credential parsing are duplicated between `@fabrika/auth` and `@fabrika/proxy`, while the proxy token header is duplicated between the proxy and apps.
- **Verify first.** Pin the current divergence matrix from ADR-0010 in `@fabrika/auth-core` tests: anchored and case-sensitive globs, `*` crossing `/`, repeated slash preservation, ordered rules, absent-credential fall-through, empty values as absent, and present-invalid credentials as terminal.
- **Scope.** Move the stable injected-header name and the canonical path matcher into `@fabrika/auth-core`; make the proxy consume them; keep credential extraction in the proxy once the SDK copy disappears. Remove the cross-package equality test and duplication warnings that no longer describe the final state. Refresh gate comments that still name in-process SDK enforcement.
- **Acceptance / witness.** Exactly one production matcher and one token-header constant remain. Proxy authorization tests and the ADR-0010 divergence matrix pass without mirrored helper implementations.
- **Touch points.** `packages/auth-core/`, `packages/proxy/`, `packages/installation-zerops/zerops/__tests__/example-app.test.ts`, and gate-related reference comments.

### WU2 — Reduce the app SDK to post-proxy identity and object authorization (effort XL)

- **Problem.** The published SDK still exposes a second front door that evaluates path gates, exchanges sessions, writes token cookies, and builds login redirects. First-party consumers still use it, so the proxy is not yet the sole enforcement point.
- **Verify first.** Inventory every public export and first-party call site. Classify it as management, injected-token verification, object authorization/audit, capability redemption, local-dev support, app-specific middleware, or retired gate enforcement. Capture the current share-link redemption and invalid-token behaviour as focused tests before deleting code.
- **Scope.** Add one minimal SDK primitive that reads the shared proxy header, verifies signature, `iss`, `aud`, and `exp`, and builds the existing `AuthContext`. Preserve `IamClient`, `FakeIamClient`, `can`/`scopedTo`/`applyScope`/`requirePermission`/`audit`, and a standalone `redeemKey` path. Remove `PropustkaAuth`, `session.ts`, gate/session middleware, login URL and token-cookie handling, and app-specific API-key middleware from the public SDK. Migrate Control, Operations, and both examples to the post-proxy primitive while preserving their private routes, bootstrap credentials, local identities, object ACLs, and fail-closed invalid-token behaviour. Update package comments and living application/auth reference.
- **Acceptance / witness.** No app-facing API can evaluate `AppGates` or exchange a browser session. Control, Operations, and examples obtain production identity only from a verified proxy token; public routes remain anonymous; protected direct access without a valid injected token fails; share-link redemption still returns an exact-resource context; object-level authorization and audit tests remain green.
- **Touch points.** `packages/auth/`, `packages/control/src/iam.ts`, `packages/operations/src/auth.ts`, `packages/operations/src/app.ts`, `examples/app/`, `examples/zerops-app/`, and `docs/reference/application-runtime.md`.

### WU3 — Publish the downstream migration contract (effort S)

- **Problem.** Poplach, Revizor, and Opice still describe the predecessor in-process auth model. Editing their already-diverged worktrees in this sprint would mix repository ownership and release sequencing.
- **Verify first.** Re-inventory their imports and distinguish path-gate enforcement from management calls, capability redemption, schema reconciliation, and app-owned ingest credentials.
- **Scope.** Add a concise migration section to Fabrika's application-runtime reference. Map each removed export to the supported post-proxy replacement and call out the required proxy topology and package-release prerequisite. Record per-app deltas without changing the external repositories.
- **Acceptance / witness.** Every removed public surface has an explicit replacement or an explicit deletion instruction, including `redeemKey`. The three named apps have a reviewable migration checklist, and no claim says they have already migrated.
- **Touch points.** `docs/reference/application-runtime.md` and read-only inventories of `projects/oss/poplach`, `projects/oss/revizor`, and `projects/oss/opice`.

### WU4 — Carry cancellation through schema reconciliation (effort M)

- **Problem.** `reconcileSchema` performs an unbounded-to-the-run `fetch`; provider execution checks cancellation before the call but cannot abandon the call once it starts.
- **Verify first.** Add a deferred-fetch test that starts reconciliation, aborts after the request begins, and proves the current promise remains pending. Cover both provider plans so the witness is not specific to one driver.
- **Scope.** Thread the run's `AbortSignal` through `SchemaReconcileInput`, each provider collaborator, `ReconcileSchemaOptions`, and the underlying `fetch`. Supply an explicit lifecycle signal to Zerops restart reconciliation. Preserve `ReconcileSchemaError` for HTTP failures and let aborts retain their native cancellation identity so the engine reports the step as cancelled.
- **Acceptance / witness.** Cancelling either provider during `reconcile-schema` aborts the HTTP request promptly, records the active step as cancelled, and skips later steps. Normal reconcile and Zerops restart-reconciliation tests remain green.
- **Touch points.** `packages/provider-contract/src/schema.ts`, `packages/auth/src/provision.ts`, `packages/provider-cloudflare/`, `packages/provider-zerops/`, and provider/engine tests.

### WU5 — Close the boundary with package and runtime witnesses (effort M)

- **Problem.** This sprint changes a public package surface and authentication on both runtime compositions; package-local tests alone cannot prove that the release graph and routed applications still agree.
- **Verify first.** Run focused auth-core, auth, proxy, Control, Operations, provider, and example suites after each work unit. Use failures to find stale contract consumers before the full gate.
- **Scope.** Run format and lint; leased workspace typecheck and full tests with PostgreSQL and MinIO coverage; local smoke; critical browser scenarios for anonymous, authorized, scoped, and Operations-unavailable states; package staging/install smoke for the public release set. Refresh generated artifacts only if their source graph changes, and review committed `wrangler.jsonc` migration arrays if regeneration occurs.
- **Acceptance / witness.** All focused and repository gates pass. Browser proof shows the proxy bounce and scoped authorization still work, local smoke survives Control and Operations restart, package smoke imports the reduced SDK from staged tarballs, and no credential or token value appears in logs or artifacts.
- **Touch points.** Root verification scripts, browser scenarios, release smoke tooling, and any generated artifact whose declared inputs changed.

## Out of scope (explicit)

- Per-client IAM mint throttling remains [backlog 21](../backlog/21-rate-limit-the-iam-mint-surface.md). It needs a separate proxy/client-identity policy, not SDK cleanup.
- The oblaka Durable Object migration rewrite remains [backlog 11](../backlog/11-oblaka-rewrites-do-migration-history.md). Its fix belongs upstream and the already-deployed migration tag must be checked before repairing this repository's history.
- Unix timestamp storage remains [backlog 22](../backlog/22-unix-second-columns-overflow-in-2038.md). It requires a separate cross-schema data-model decision and is not urgent.
- npm bootstrap and predecessor package/repository retirement remain [backlog 25](../backlog/25-bootstrap-npm-trusted-publishing.md) and [backlog 26](../backlog/26-retire-trasa-release-surface.md).
- No edits, releases, or deployments in the standalone Poplach, Revizor, or Opice repositories. This sprint produces their migration contract only.
- No change to proxy topology, gate precedence, token claims, IAM admission policy, or ADR-0007/0010 boundaries.

## Decisions

- The final state, not an intermediate compatibility state, controls the design: `@fabrika/auth-core` owns the wire header and pure gate matcher; only the proxy evaluates gates; apps consume a verified identity and enforce object permissions.
- Credential extraction stays with the proxy after the SDK copy is deleted. Hoisting unused readers into core would preserve abstraction without eliminating duplication.
- Missing or invalid injected identity is data from the SDK primitive; each application composition decides whether its route is public or must fail. The SDK does not regain path knowledge.
- Capability redemption remains an explicit off-gate operation. It does not justify retaining session authentication or gate middleware.
- The provider contract carries an explicit signal for schema reconciliation. A pre-call abort check is not a substitute for cancelling the in-flight transport.
- Cross-repository consumers receive documentation in this sprint. Their migration and release remain separately authorized work.

## Sequencing

1. WU1 freezes the shared wire and matcher contract.
2. WU2 builds the final SDK surface and migrates first-party consumers.
3. WU3 records the external migration contract from WU2's actual final API.
4. WU4 can be developed alongside WU1/WU2 except for small overlaps in `@fabrika/auth` exports and provider test fixtures; integrate it after the SDK shape settles.
5. WU5 runs after all code and documentation changes are integrated.

## Run log

<!-- Append as you work: discoveries, deviations, blockers. Graduate each entry:
     changed the *why* → ../decisions/NNNN ; new future work → ../backlog/NN ;
     transient → leave it (dies with the sprint on archive). After graduating,
     trim to a one-line pointer ("→ ADR-0007"). -->

- 2026-07-31 — WU4 shipped as `695d47b`: both providers now cancel in-flight IAM schema reconciliation with the deploy signal.
- 2026-07-31 — WU1 shipped as `a82567a`: auth-core now owns the sole gate matcher and injected-token header contract.
- 2026-07-31 — WU2 verify-first found that the accepted Cloudflare thin-proxy path is not implemented. Cloudflare apps, Control, and Operations still have direct routes and depend on in-process enforcement. Deleting it now would lock out or weaken the Cloudflare composition; WU2 is paused pending an explicit scope decision.
