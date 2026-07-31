# Sprint — Operations adoption proof (2026-07-31)

## OUTCOME

Shipped a deterministic browser proof for the unified Operations console and a
managed error-ingest witness using the official Sentry browser SDK.

- `41fd84a` adds the Opice harness, real IAM browser identities, isolated
  Operations fixtures, ten operator scenarios, the Zerops example SDK witness,
  and the narrow runtime fixes exposed by the proof.
- The SDK witness pins `@sentry/browser` 10.69.0 and proves two native `event`
  envelopes group into one issue with the managed release.
- The outage witness exposed a missing private-transport timeout. Control now
  bounds Operations requests at five seconds, so the console shows an explicit
  unavailable state while Delivery and Access remain usable.

Verification:

- Two final consecutive reset-to-clean browser runs passed with zero configured
  retries: extended 10/10 scenarios in 70.92 s, then critical 4/4 executed
  scenarios in 38.58 s. Each run removed its containers and volumes.
- Two earlier extended gate attempts found and fixed an asynchronous ingest race
  in the triage witness and an unbounded Playwright response-body observer. No
  known flaky scenario remains.
- `cpu-lease run -n 4 -- bun run typecheck` passed every workspace package.
- `cpu-lease run -n 4 -- bun test` passed 1,383 tests; 134 opt-in integration
  tests skipped in that process because no host backend variables were set.
- A separate live PostgreSQL/MinIO run passed 110 tests across eight integration
  files, including platform-node, IAM, Control, and Operations.
- `bun run local:smoke` passed after a reset, including Control and Operations
  restart recovery (run `019fb8a6-b4e3-7069-b3ae-66962afb74b0`), and
  `local:down` removed the composition.
- Format, `git diff --check`, and lint passed. Lint retains seven warnings and
  550 informational diagnostics.
- Agent-docs lint reports only the existing compatibility symlink
  `docs/AGENTS.md -> CLAUDE.md` as a stray root file.

No sprint work was deferred. Existing-state Poplach retirement, Zerops artifact
correlation, DNS-safe Operations egress, and a credentialed real-account deploy
remain their separate backlog items. This sprint is not real Zerops account
evidence.

**Goal.** Prove that an application can adopt Fabrika Operations through the
official Sentry browser SDK and that an operator can complete the supported
console workflows through the real local composition.

**Theme.** The Operations foundation has strong domain, HTTP, and local-stack
coverage, but its two user-facing boundaries remain unproven: a browser SDK
sending a managed event, and a human operating the unified console. This sprint
consumes backlog 35 without expanding the Operations feature set.

## Refs re-verified at HEAD (2026-07-31)

- ✔ The unified console mounts Delivery, Access, and Operations in one shell,
  with five Operations destinations already present in the navigation —
  `packages/dashboard/src/routes/_layout.tsx:42`.
- ✔ Operations browser calls use the typed `OperationsRpcContract` through the
  same-origin `/operations/api/rpc` gateway, including issue mutations, bulk
  status, releases, health, and alert settings —
  `packages/operations-ui/src/client.ts:28` and
  `packages/operations-ui/src/client.ts:63`.
- ✔ The gateway preserves Operations ownership, rejects cross-origin unsafe
  requests, maps transport failure to 503, and supplies the public IAM login URL
  on an authentication failure — `packages/control/src/operations-gateway.ts:13`.
- ✔ The Operations RPC router exposes every workflow required by the existing
  UI and refuses to construct operator use cases without an authenticated
  `AuthContext` — `packages/operations/src/operator-rpc.ts:21` and
  `packages/operations/src/operator-rpc.ts:89`.
- ✔ The local stack already runs the real dashboard, IAM, Control, Operations,
  PostgreSQL, MinIO, proxies, and an application namespace. Its public
  Operations host exposes only envelope ingest and source-map upload —
  `packages/local-stack/compose.yaml:80` and
  `packages/local-stack/src/prepare.ts:100`.
- ⚠ The local smoke hand-builds a Sentry envelope, sends it with `fetch`, and
  queries the operator API from inside the Operations container. It proves
  persistence and grouping, but neither an official SDK nor the browser gateway
  — `packages/local-stack/src/smoke.ts:433` and
  `packages/local-stack/src/smoke.ts:462`.
- ⚠ Control and Operations run with `DEV=true` in the local composition, so a
  plain browser receives the default admin persona. That composition cannot
  currently witness an unauthenticated login bounce or a scoped principal —
  `packages/local-stack/compose.yaml:104` and
  `packages/local-stack/compose.yaml:144`.
- ⚠ The root and dashboard scripts expose no browser-test command, and the
  workspace has no maintained browser harness — `package.json:9` and
  `packages/dashboard/package.json:6`.
- ⚠ Neither worked application depends on an official Sentry SDK. The Zerops
  example is already the application exercised by the full local stack, so it is
  the cheapest honest adoption fixture to extend —
  `examples/zerops-app/package.json:27` and
  `packages/local-stack/compose.yaml:215`.

## Work units

### WU1 — Add a deterministic Operations browser harness (effort L)

- **Problem.** UI unit tests prove route and view contracts, but no browser drives
  the built console against its real services.
- **Verify first.** Run `local:reset`, `local:smoke`, and a manual read-only console
  walk before changing the stack. Record stable accessible names and identify
  where generated or random fixture values need a setup command rather than a
  selector workaround.
- **Scope.** Add Opice as the repository's deterministic browser harness, an
  offline local configuration, browser setup/teardown commands, and a root
  `test:browser` script. Reuse `@fabrika/local-stack`; do not create a mock
  Operations server. Make fixture state unique per scenario and keep generated
  sessions, credentials, reports, screenshots, and local stack state ignored.
- **Acceptance / witness.** One critical scenario starts from a reset stack,
  opens the built console through `control.localhost`, visits all three planes,
  and leaves the stack healthy. Re-running it produces the same result without
  relying on scenario order or committed credentials.
- **Touch points.** `package.json`, `bun.lock`, `opice.config.json`,
  `tests/browser/`, `packages/local-stack/`, `.gitignore`.

### WU2 — Build honest browser identities and fixtures (effort L)

- **Problem.** `DEV=true` always supplies a synthetic default principal, while
  the acceptance needs anonymous, authorized, and application-scoped
  browser states.
- **Verify first.** Confirm the real `px_session` path across Control's gateway and
  Operations with a session created through IAM repositories. Confirm that the
  unauthenticated RPC response carries a login URL before automating it.
- **Scope.** Give the browser setup a local-only way to create a real IAM
  principal, grants, and session through the shipped repository/API surfaces,
  then install only the plaintext session cookie in the isolated browser
  context. Add deterministic Operations sources, releases, issues, events,
  source maps, health observations, and alert fixtures through supported
  protocols. Provide one principal scoped to exactly one application and at
  least one hidden sibling source. Do not add a production
  fixture endpoint or write raw secrets to logs.
- **Acceptance / witness.** Separate contexts prove: no session produces the IAM
  login bounce; the authorized session loads Operations; the scoped session can
  see its source and cannot infer the hidden source through list totals, direct
  identifiers, release detail, DSN/config responses, alert targets, or health
  data.
- **Touch points.** `tests/browser/`, `packages/local-stack/`, IAM local setup,
  Operations fixture builders and access tests.

### WU3 — Prove the operator workflows in a real browser (effort XL)

- **Problem.** The UI exposes the Operations workflows, but no browser witness
  proves that its forms, route invalidation, same-origin gateway, RPC contracts,
  and persisted state agree.
- **Verify first.** Inventory the legacy Poplach browser scenarios and map each
  still-valid behavior to a visible Fabrika route. Check every intended selector
  against a role, label, or deliberate test id before authoring executable
  steps.
- **Scope.** Author independent scenarios for:
  1. three-plane navigation and Operations overview;
  2. issue search/status filters and list-to-detail navigation;
  3. bulk status, comment, assignment, snooze, resolve-in-release, and merge;
  4. event detail, resolved source context, release links, new-issue and
     regression correlation;
  5. source detail, health-check create/update/delete, and health state;
  6. spike/rule changes plus webhook channel create, redacted read-back,
     enable/disable, and delete.

  Assert persisted outcomes after navigation or reload, not only transient DOM
  state. Send every mutation through the same-origin gateway and retain the
  existing CSRF rejection witness.
- **Acceptance / witness.** `bun run test:browser` passes the critical tier and
  the extended workflow tier from a reset local stack. Each scenario can pass in
  isolation. The run covers every browser workflow named in backlog 35, and a
  source-inventory note accounts for each imported Poplach scenario as covered,
  obsolete, or deliberately deferred.
- **Touch points.** `tests/browser/`, `packages/dashboard/`,
  `packages/operations-ui/`, `packages/control/src/operations-gateway.ts`, local
  fixture helpers.

### WU4 — Prove bounded Operations failure (effort M)

- **Problem.** The gateway maps an unavailable Operations service to 503, but the
  running console has not proved that the failure stays inside the Operations
  plane.
- **Verify first.** Stop only the Operations service in the local composition and
  record the current console response and recovery behavior.
- **Scope.** Add a harness-owned disruption scenario that stops Operations,
  observes the bounded unavailable state, verifies Delivery and Access remain
  usable, restarts Operations, and waits for health before teardown. Ensure the
  scenario restores the service even when an assertion fails.
- **Acceptance / witness.** The Operations workspace shows an explicit
  unavailable state within the client/gateway timeout; the shell, Delivery, and
  Access remain functional; Operations recovers without resetting shared state.
- **Touch points.** `tests/browser/`, `packages/operations-ui/src/components/Unavailable.tsx`,
  `packages/control/src/operations-gateway.ts`, `packages/local-stack/`.

### WU5 — Send a managed error through the official browser SDK (effort L)

- **Problem.** The current smoke constructs the envelope itself, so it can hide a
  compatibility gap between Fabrika's ingest parser and the SDK applications
  actually install.
- **Verify first.** Capture the envelope items emitted by the selected stable
  `@sentry/browser` version for one thrown browser exception. Compare them with
  the Operations ingest allow-list before changing either side.
- **Scope.** Extend the Zerops example with a minimal browser fixture and initialize
  the official SDK from runtime-provided `FABRIKA_OPERATIONS_DSN` and
  `FABRIKA_RELEASE`. Expose only browser-safe managed values. Trigger one marked
  exception from the browser, observe the envelope request, then poll through the
  operator gateway for its grouped issue. Add only the narrow envelope-item
  compatibility needed by the chosen SDK; do not claim general Sentry protocol
  parity.
- **Acceptance / witness.** The browser sends through the managed DSN, the ingest
  endpoint answers 202, asynchronous processing produces exactly one grouped
  issue with the expected release, and a second equivalent exception increments
  that issue instead of creating another. Application-facing reference records
  the exact tested SDK version and supported envelope items.
- **Touch points.** `examples/zerops-app/`, `packages/local-stack/`,
  `packages/operations/`, `packages/operations-contract/`,
  `docs/reference/application-runtime.md`, browser scenarios.

### WU6 — Close the proof with repeatable gates (effort M)

- **Problem.** A browser run is useful only if its prerequisites, duration, and
  failure artifacts are explicit and repeatable.
- **Verify first.** Run every scenario alone, then in the documented tier order,
  and identify any state or timing dependency before the final gate.
- **Scope.** Document browser setup, tier selection, local failure artifacts, and
  cleanup. Run format, lint, leased workspace typecheck/tests, local smoke, and
  both browser tiers. Update living Operations/application reference where the
  witnessed behavior is now stronger than the current text.
- **Acceptance / witness.** Two consecutive reset-to-clean runs pass. The closure
  record reports scenario counts, retry/flaky counts, duration, full repository
  test counts including real PostgreSQL/S3 coverage, and confirms that
  `local:down` removed the test composition.
- **Touch points.** Root scripts, `docs/reference/`, browser-test documentation,
  this sprint's closure block.

## Out of scope (explicit)

- Existing Poplach state adoption, production cutover, package deprecation, or
  repository retirement remain [backlog 34](../backlog/34-retire-standalone-poplach.md).
- Zerops source-map publication and Delivery-to-Operations release links remain
  [backlog 36](../backlog/36-complete-zerops-release-artifact-correlation.md).
- Transactional Zerops managed-environment activation remains
  [backlog 37](../backlog/37-activate-zerops-managed-environment-transactionally.md).
- DNS-pinned production egress for webhooks and health checks remains
  [backlog 38](../backlog/38-add-dns-safe-operations-egress.md).
- A credentialed Zerops deployment remains
  [backlog 05](../backlog/05-bring-up-on-a-real-zerops-account.md). Local browser
  proof must not be described as real-account evidence.
- Restoring general CI/release workflows remains
  [backlog 25](../backlog/25-migrate-the-ci-workflows.md). This sprint adds a
  stable command that CI can call; it does not create the pipeline.
- Full Sentry SDK/protocol compatibility, session replay, tracing, logs, and
  metrics. The witness is one documented browser error-ingest profile.
- A visual redesign of the console. Accessibility or state changes required for
  deterministic interaction are in scope; aesthetic changes are not.

## Decisions

- Use Opice for deterministic browser scenarios and keep reporting optional for
  local runs. The executable test is the durable artifact; no LLM participates
  in verification.
- Extend the existing local stack instead of building a second browser-specific
  service graph. Browser proof uses the same PostgreSQL, MinIO, gateways,
  proxies, and application namespace as `local:smoke`.
- Use real IAM sessions for authenticated browser evidence. The login-bounce
  scenario proves the generated redirect boundary but does not pretend to test
  an external OIDC provider.
- Extend the Zerops example for the official SDK witness because it already
  receives the managed DSN/release and runs in the full local composition.
- Split scenarios into a small critical navigation/adoption tier and an extended
  mutation/degradation tier. Every scenario remains independently runnable.

## Sequencing

| Order | Work        | Dependency / parallelism                                                      |
| ----- | ----------- | ----------------------------------------------------------------------------- |
| 1     | WU1         | Establish the harness, lifecycle, and selector contract.                      |
| 2     | WU2 and WU5 | Fixture/auth work and SDK adoption can proceed in parallel once setup exists. |
| 3     | WU3         | Author the workflow matrix against stable identities and fixtures.            |
| 4     | WU4         | Add disruption only after the ordinary browser path is deterministic.         |
| 5     | WU6         | Run both tiers twice, then the complete repository and local-stack gates.     |

Close the sprint only when backlog 35 can be deleted, the browser command is
documented and repeatable, and the official SDK witness reaches one persisted
grouped issue through the managed configuration path.

## Run log

<!-- Append as you work: discoveries, deviations, blockers. Graduate each entry:
     changed the *why* → ../decisions/NNNN ; new future work → ../backlog/NN ;
     transient → leave it (dies with the sprint on archive). After graduating,
     trim to a one-line pointer ("→ ADR-0007"). -->

- The original WU2 draft asked for an application-environment intersection.
  Operations access intentionally treats app and environment grants as
  independent alternatives (`app OR environment`), so no such coordinate grant
  exists. The browser witness uses the supported application scope and proves a
  sibling application is absent from lists, summaries, and direct resources.
