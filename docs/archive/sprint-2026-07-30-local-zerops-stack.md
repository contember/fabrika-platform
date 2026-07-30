# Sprint — Local Zerops stack (2026-07-30)

## OUTCOME

Shipped and exercised the complete local Zerops-targeted Fabrika stack.

- `7895bb8` adds the stateful Zerops REST emulator.
- `b52a451` separates the public IAM issuer from the private management RPC
  origin.
- `5d0084a` composes the real IAM, control, notes, PostgreSQL, MinIO, proxy auth,
  and Caddy processes.
- `7e450f1` makes namespaced Zerops onboarding operational with claim-first
  provider preparation and cleanup.
- `b8fcd92` adds delayed provider state, public-IAM-only app connectivity, and
  the disruptive full-lifecycle smoke command.

Verification:

- `bun run local:smoke` passed repeatedly, including a hard control-plane kill
  during `BUILDING`, startup reconciliation, IAM schema reconciliation,
  authenticated notes persistence, and private-network isolation.
- `cpu-lease run -n 4 -- bun test` passed 1,098 tests; 117 integration tests
  skipped because their external Postgres/S3 services were not configured.
- `cpu-lease run -n 4 -- bun run typecheck` passed every workspace package.
- Lint completed with no errors; five warnings and 249 informational diagnostics
  remain.
- Format checking and `git diff --check` passed.

The emulator remains deliberately narrower than Zerops. Credentialed platform
validation, builds, runtime placement, autoscaling, HA, L7 domain binding, and
provider log behavior remain for
[backlog 05](../backlog/05-bring-up-on-a-real-zerops-account.md).

**Goal.** Run the complete Fabrika control and data plane locally before the
first credentialed Zerops deployment.

**Theme.** Docker owns real runtime processes, databases, object storage,
networks, and proxies. A narrow stateful emulator owns only the Zerops REST
protocol observed by the provider.

## Refs re-verified at HEAD (2026-07-30)

- ✔ IAM and control have long-running Bun composition roots backed by Postgres,
  filesystem assets, HTTP IAM RPC, and S3-compatible run storage —
  `packages/iam/src/node/runtime.ts`,
  `packages/control/src/node/runtime.ts`.
- ✔ The control composition accepts `ZEROPS_API_BASE_URL`, but still requires
  the complete Zerops provider configuration at boot —
  `packages/control/src/node/provider.ts`.
- ✔ Proxy authorization and Caddy configuration are independently runnable, but
  deliberately share one loopback network namespace in production —
  `packages/proxy/src/main.ts`, `packages/proxy/start.sh`.
- ✔ The worked Zerops app is a real Bun/Postgres service with proxy-injected JWT
  verification — `examples/zerops-app/src/server.ts`.
- ⚠ No local orchestrator or HTTP Zerops emulator exists. Provider fakes are
  test-local objects only.
- ⚠ Dashboard onboarding still constructs Cloudflare envelopes and cannot
  register a Zerops manifest into a namespace —
  `packages/dashboard/src/routes/index.tsx`.
- ⚠ The Node control runtime uses `PROPUSTKA_URL` for both internal IAM RPC and
  public issuer validation, although those origins differ in the Zerops
  topology.

## Work units

### WU1 — Add a narrow stateful Zerops API emulator

- Implement only the endpoints called by `createZeropsApi`.
- Persist logical projects, services, service variables, and app versions.
- Parse provider import YAML, assign stable ids, and support deterministic
  success, cancellation, reset, and inspection.
- Prove the real HTTP client against the emulator handler.

### WU2 — Compose the real local runtime

- Run Postgres, MinIO, IAM, control, the worked app, and platform/app proxies.
- Use separate Docker networks for the platform and application namespace.
- Build UI assets and apply all three Postgres migration sets before readiness.
- Provide `local:up`, `local:status`, `local:reset`, and `local:down`.

### WU3 — Close IAM addressing and local bootstrap

- Separate the IAM public issuer from its private RPC origin in the Node
  composition.
- Generate stable local signing, RPC, proxy, provisioning, and vault keys.
- Seed the IAM schema and the control registry without storing secrets in git.

### WU4 — Make Zerops onboarding operational

- Accept a built Zerops manifest and compatible namespace without raw project
  coordinates.
- Provision/discover the deploy service before storing target v2.
- Keep resource-claim acquisition ahead of provider mutation and fail without
  leaving an orphan app.

### WU5 — Prove the end-to-end path

- Create a cheap namespace with shared PostgreSQL.
- Onboard and deploy the notes app through control.
- Exercise public and authenticated proxy routes.
- Restart control during a provider run and verify reconciliation.
- Keep mid/full topology witnesses deterministic.

## Out of scope

- Emulating Zerops builds, autoscaling, HA, L7 domain binding, or undocumented
  log-service behavior.
- Claiming that local success proves real Zerops behavior.
- Deploying or publishing from localhost.

## Decisions

- Docker is the runtime source of truth. The emulator never starts containers.
- Emulator `ACTIVE` means the provider operation converged and the matching
  predeclared local service is healthy; it does not claim a Zerops build ran.
- The first full runtime witness uses the cheap preset. Mid and full retain
  compiler/provider witnesses and may use separate Compose profiles.

## Sequencing

WU1 and the runtime inventory establish the seam. WU2 and WU3 make the platform
bootable. WU4 closes onboarding before WU5 drives the complete flow.

## Run log

- 2026-07-30 — Started after the namespace sprint to provide a pre-deployment
  witness stronger than schema validation and in-process provider fakes.
- 2026-07-30 — The app namespace needs public IAM reachability for JWKS, but no
  platform-private access. Added the narrow `iam-public` network.
- 2026-07-30 — Zerops app versions need a visible in-progress state to exercise
  restart reconciliation. The emulator now delays `BUILDING → ACTIVE` without
  pretending to run application containers.
