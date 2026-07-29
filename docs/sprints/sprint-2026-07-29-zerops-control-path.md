# Sprint — Zerops control path (2026-07-29)

**Goal.** Make a registered Zerops app deployable from the control plane without
executing repository code, persist secret edits directly on its services, and
recover in-flight deploys after a process restart.

**Theme.** Backlog items 12–16 are one delivery path. The static manifest is the
trusted data boundary. The app-env registry supplies Zerops topology. The same
topology addresses deploys, proxy configuration, secret writes, and restart
reconciliation.

## Refs re-verified at HEAD (2026-07-29)

`✔` = confirmed live · `⚠` = drift or nuance caught while planning.

- ✔ `ZeropsAppTarget.services` is still executable code, and the Zerops driver
  invokes it while opening a deploy — `packages/config/src/zerops/types.ts:73`,
  `packages/engine/src/drivers/zerops/index.ts:240`.
- ✔ The CLI accepts only `deploy` and `platform deploy`; it cannot emit
  `fabrika.manifest.json` — `packages/engine/src/cli.ts:8`,
  `packages/engine/src/cli.ts:213`.
- ✔ `app_envs` has no platform discriminator, project id, service id, or static
  manifest. Its upsert writes only domain and trigger ref —
  `packages/control/src/db.ts:30`, `packages/control/src/db.ts:233`.
- ✔ The run lifecycle always assembles a Cloudflare `RunnerJob` and calls the
  runner, while the Zerops process intentionally has no runner —
  `packages/control/src/run-lifecycle.ts:88`,
  `packages/control/src/services.ts:81`.
- ✔ The Zerops API already exposes service-scoped `putServiceEnv` and
  app-version reads. Neither is called by the control plane —
  `packages/engine/src/drivers/zerops/api.ts:211`,
  `packages/engine/src/drivers/zerops/api.ts:249`.
- ✔ Secret value routes always construct the encrypted vault path. They cannot
  dispatch by the target platform — `packages/control/src/api/router.ts:155`,
  `packages/control/src/api/vault.ts:38`.
- ✔ Maintenance performs a generic age sweep, and the Bun entrypoint starts the
  consumer without first reconciling platform-owned runs —
  `packages/control/src/cron.ts:40`,
  `packages/control/src/node/server.ts:66`.
- ⚠ The proxy build already validates a service-variable payload and fails
  closed, but nothing in the deploy path writes that payload —
  `deploy/zerops/setups.ts:202`, `deploy/zerops/setups.ts:227`.

## Work units

### WU1 — Ratify the proxy manifest path (backlog 12, effort M)

- **Problem.** The proxy expects `FABRIKA_PROXY_MANIFEST_JSON`, but no owned path
  produces or writes it and the empty-path behaviour lacks an end-to-end witness.
- **Verify first.** Exercise the strict parser and generated auth config with a
  missing, malformed, and empty manifest.
- **Scope.**
  1. Keep the accepted baked-manifest/redeploy model.
  2. Add proxy metadata to the static app manifest contract.
  3. Compile one fail-closed proxy payload from registered app manifests.
  4. Write it only to the proxy service through the Zerops service-env API before
     a deploy that changes routing or gates.
- **Acceptance / witness.** Tests prove that a valid registered app produces the
  expected proxy entry, and missing/malformed/no-match input cannot authorize a
  request.
- **Touch points.** `packages/config`, `packages/proxy`,
  `packages/control/src/zerops-*`, `deploy/zerops`.

### WU2 — Compile app config to a static manifest (backlog 16, effort L)

- **Problem.** ADR-0005's build artefact and compatibility boundary do not exist.
- **Verify first.** Compile the current Zerops example for one environment and
  record every value the driver consumes.
- **Scope.**
  1. Define and strictly decode a versioned `fabrika.manifest.json`.
  2. Add `fabrika build --env=<env> [--config] [--output]`.
  3. Evaluate app code only in that build command and emit declared variables as
     `${VAR}` placeholders.
  4. Let the Zerops driver consume a decoded manifest with deploy-time
     interpolation and reject app/environment drift.
- **Acceptance / witness.** CLI and decoder tests prove deterministic output,
  rejection of incompatible/drifted manifests, and interpolation without
  executing app modules in the control-plane path.
- **Touch points.** `packages/config/src/manifest.ts`,
  `packages/engine/src/manifest.ts`, CLI files, Zerops compiler/driver tests,
  `examples/zerops-app`.

### WU3 — Drive Zerops deploys in process (backlog 13, effort L)

- **Problem.** Every queued deploy currently requires a Cloudflare runner and the
  registry cannot describe a Zerops target.
- **Verify first.** Run lifecycle tests with `RUNNER` absent and confirm the
  current failure.
- **Scope.**
  1. Add backward-compatible D1 and Postgres app-env columns for platform,
     Zerops project/service ids, and the static manifest.
  2. Expose those fields through registry/onboarding APIs with strict validation.
  3. Dispatch the run lifecycle by app-env platform.
  4. Build a `ZeropsTarget` from the registry plus platform PAT and run the
     existing engine driver directly in process.
- **Acceptance / witness.** A registered Zerops app-env reaches
  apply-import → trigger-deploy → await-deploy → reconcile-schema with no
  `RunnerJob`; Cloudflare behaviour remains unchanged.
- **Touch points.** control migrations, DB/registry APIs, runtime env/services,
  run lifecycle, Zerops engine entrypoint, tests.

### WU4 — Write Zerops secret edits through immediately (backlog 14, effort M)

- **Problem.** Zerops is the system of record for app secret values, but all value
  routes currently write to the control-plane vault.
- **Verify first.** Confirm that all-env and env-specific secret layers can be
  mapped to the registered deploy service without project-level writes.
- **Scope.**
  1. Dispatch secret value mutations by app-env platform.
  2. For Zerops, require an environment and write/delete the named value on the
     registered service through the service-env API.
  3. Store only a non-value platform reference in `app_secrets`.
  4. Leave Cloudflare vault semantics unchanged.
- **Acceptance / witness.** API tests prove immediate service-level set/rotate/
  delete, no vault ciphertext for Zerops, and no project-env mutation surface.
- **Touch points.** control API/router/services, Zerops client seam, registry and
  vault tests.

### WU5 — Reconcile in-flight Zerops runs (backlog 15, effort M)

- **Problem.** A process restart loses the in-memory await loop, and the generic
  stale sweep can mark a still-active Zerops version failed.
- **Verify first.** Seed pending/running Zerops runs with active and terminal
  app-version states and execute startup plus maintenance.
- **Scope.**
  1. Persist the triggered app-version id on the run.
  2. Reconcile pending/running Zerops runs from `/app-version` before the Bun
     consumer starts and during maintenance.
  3. Mark terminal states idempotently and leave active states in flight.
  4. Exclude active Zerops runs from the generic stale sweep.
- **Acceptance / witness.** Restart tests prove ACTIVE → succeeded, failed
  terminal → failed, active → unchanged, and stale sweep does not reap a
  platform-confirmed active version.
- **Touch points.** migrations, DB run methods, Zerops lifecycle/reconciler,
  `node/server.ts`, `cron.ts`, tests.

## Out of scope (explicit)

- A real-account deployment remains in
  [`../backlog/05-bring-up-on-a-real-zerops-account.md`](../backlog/05-bring-up-on-a-real-zerops-account.md);
  this sprint performs no deploy or publish from localhost.
- App-wide secret replication across several environment projects remains in
  [`../backlog/10-app-scope-secrets-on-zerops.md`](../backlog/10-app-scope-secrets-on-zerops.md).
- Multi-domain service behaviour remains in
  [`../backlog/09-confirm-multi-domain-per-service.md`](../backlog/09-confirm-multi-domain-per-service.md).

## Decisions

- The manifest is versioned JSON generated in the app build. The control plane
  stores it on the app-env and never imports the app's TypeScript.
- `fabrika build` is environment-specific. It may evaluate the existing config
  function in the app build, while declared deploy variables are placeholders.
- The proxy manifest remains baked into the proxy service via
  `FABRIKA_PROXY_MANIFEST_JSON`. The control plane writes it as a non-secret,
  service-scoped variable and a proxy redeploy activates it.
- Zerops secret edits require an explicit app environment. App-wide replication
  is not inferred in this sprint.

## Sequencing

1. WU1 and WU2 define the manifest boundary and proxy payload.
2. WU3 stores and executes that boundary.
3. WU4 uses the registered service address.
4. WU5 makes the new execution path crash-safe.

## Run log

- 2026-07-29 — Planning confirmed that no live-account credential is needed for
  the five code paths. Real bring-up stays in backlog 05.
