<!--
On close, prepend an OUTCOME block here, then `git mv` this file to ../archive/:

> **OUTCOME — shipped YYYY-MM-DD.** <one-paragraph result.> Commit map: WU1 → <sha>,
> WU2 → <sha>, … Verification: <the gate command + numbers>. Backlog closed:
> <ids deleted/rescoped>. Deferred: <honest notes>.
-->

# Sprint — Second simplification pass (2026-10-08)

**Goal.** Fix four defects found by a six-area review, then remove the dead code, duplicate models and
extra packages that review found, without dropping a feature.

**Theme.** The [first pass](../archive/sprint-2026-10-07-simplify-delivery-and-providers.md) cut the
delivery path. A follow-up review of Control, Access, Operations, the runtime ports, the builder and the
tooling found a second layer:

- speculative API with no caller;
- the same thing implemented 2–4 times (UUIDv7, same-origin checks, builder phases, GitHub credential models);
- packages split with one consumer;
- migration history kept for installations that D2 says do not exist.

Success:

- every item below lands or is recorded as deferred;
- the feature set is unchanged: builder, Cloudflare as a platform host, Operations, repo polling and
  share links all stay.

## Refs re-verified at HEAD (2026-10-08, `902fb08`)

- ✔ Production secret resolution has only the vault backend — `packages/control/src/services.ts:107`; `literal:` resolves unconditionally — `packages/control/src/secret-resolver.ts:122`; the console suggests `env:STRIPE_KEY` — `packages/dashboard/src/components/app-detail/SecretsSection.tsx:240`.
- ✔ The builder signals a PID read from its PID file without checking it is still its daemon — `packages/builder/cli/src/daemon-lifecycle.ts:113,135`.
- ✔ Pipeline telemetry reports `rejects` and `queue` as unavailable on both runtimes — `packages/operations/src/telemetry.ts:74-93`.
- ✔ Builder phases name skills that exist nowhere (`intake-classification`, `rfc2119-principles`, …) — `packages/builder/cli/src/phases.ts`.
- ✔ Four UUIDv7 generators — `packages/auth-core/src/ids.ts`, `packages/control/src/uuid.ts`, `packages/platform-node/src/uuid.ts`, `packages/operations/src/uuid.ts`.
- ✔ `issueJwt` has callers only inside `auth`, `auth-core`, `iam` (grep, non-test).
- ✔ Migration files: control 44 (D1 + Postgres), iam 22, operations 12; ADR-0017 says a legacy ledger "is never renamed, rewritten, or dropped" — `docs/decisions/0017-service-owned-postgres-migrations.md:79`.

Re-check every other `file:line` in a unit when it starts.

## Decisions

- **D1 — Feature set stays.** The builder (and its device authorization and pairing), Cloudflare as
  a platform host, Operations, repo polling for apps without an App installation, and share links
  are not removed.
- **D2 — Squash migrations.** One initial migration per bundle and dialect. Live test installations
  are reinstalled. ADR-0017 is rewritten: migration identity stays `(bundle, filename)`, the legacy
  `schema_migrations` adoption goes.
- **D3 — Operations `serviceKey` stays.** It is always `'default'` today, but removing it changes the
  ingest wire and a primary key for a small saving. Revisit before 1.0 if per-service DSNs are still
  not planned.
- **D4 — Secrets are vault-only.** `env:`, `secretstore:` and `literal:` refs go, along with the raw
  `valueRef` input. Tests that need a secret use the vault with a test key.
- **D5 — One GitHub credential model.** Cloudflare moves to the vault-backed connections that Zerops
  uses. This keeps multiple connections (first-pass D6) on both clouds.
- **D6 — Canvas packages stay here.** `canvas-kernel`, `annotations` and `daemon-kit` remain in this
  repository; `agent-canvas` keeps consuming them from npm.

## Work units

### Wave 0 — shared seams

#### WU0.1 — One UUIDv7 and shared port doubles (S)

- **Problem.** Four UUIDv7 copies (refs above). `auth-core/src/ids.ts:33` says the copies exist because
  Control and platform-node may not depend on auth-core; both depend on `@fabrika/platform`. The same
  `MemoryBlobs`/`EmptyQueue`/`MemoryQueue` classes are in 8 Operations test files, and an `unusedDatabase`
  stub is in 13 IAM test files.
- **Scope.**
  - Put one `uuidv7` in `@fabrika/platform`; delete the other three copies and their duplicate tests.
    Keep the `auth-core` export as a re-export only if an external consumer needs it; check `auth`.
  - Add `@fabrika/platform/testing` with the shared doubles and switch the test files to it.
- **Acceptance.** One `uuidv7` implementation (grep). Typecheck and the full suite are green.
- **Touch points.** `platform`, `platform-node`, `auth-core`, `control`, `operations`, and test files in `iam` and `operations`.

### Wave 1 — defects and local cleanups (parallel)

#### WU1.1 — Vault-only secret refs (S–M)

- **Problem.** See refs. An `env:` ref can never deploy, and a `literal:` ref stores the secret as
  plaintext in `app_secrets.value_ref`.
- **Scope.**
  - The resolver knows only `vault:`. `apps.secrets.put` accepts a value and writes it to the vault,
    and no raw ref input remains.
  - Fix the console form and remove `EnvSecretResolver`. Fix the stale `zerops:` comment at
    `db/registry-types.ts:107`.
  - Move tests to a vault with a test key.
- **Acceptance.** A test proves that a stored `literal:` or `env:` ref is refused at write. A deploy
  with a vault secret passes `local:smoke`.
- **Touch points.** `control/src/{secret-resolver,services}.ts`, `control/src/api/registry/configuration.ts`, `dashboard/src/components/app-detail/SecretsSection.tsx`, `control-contract`.

#### WU1.2 — Builder: daemon-kit lifecycle, one phase table, real skills (M)

- **Problem.**
  - `stopDaemon()` signals an unchecked PID (refs).
  - `cli/src/daemon-lifecycle.ts` and `waitForFeedback` reimplement `daemon-kit`'s
    `createDaemonLifecycle` and `waitForEvent`.
  - Phases are defined four times: `cli/src/phases.ts`, `daemon/src/phases.ts:4-90`,
    `ui/src/lib/phases.ts`, `shared/index.ts:69`.
  - 19 phase skill names do not exist.
- **Scope.**
  - Use `daemon-kit` for the lifecycle and the waiter.
  - Keep one phase table in `shared/`, from which the CLI, the daemon and the UI derive.
  - Keep only skill names that exist (`opice-plan`, `opice-author`, `fabrika`), or drop the field if
    none applies to a phase.
- **Acceptance.**
  - A test where the PID file names a foreign live process: stop does not signal it.
  - The builder suites are green, and the packet output lists no unknown skill.
- **Touch points.** `packages/builder/**`.

#### WU1.3 — Operations internals (S)

- **Problem.**
  - Telemetry health can never be `healthy`, so the console shows "unavailable" (refs). Dead pieces:
    the `recovery` transition, the reject and queue thresholds (`health-service.ts:21-23`), the legacy
    `freshnessMs`, and `EMAIL_DELIVERY_SUPPORT` (`health.ts:295`).
  - `operator-rpc-validation.ts` rewrites zod issues into old REST strings.
  - `import/poplach-source-inventory.ts` is migration history.
  - `@fabrika/operations` is public, yet only `./gates` has an outside caller.
- **Scope.**
  - Telemetry: "dead letters > N → failed, else healthy". Delete `PipelineTelemetryFacts` and the
    availability union.
  - Pass zod schemas to the RPC directly, and update the `http-isolation.test.ts` rows.
  - Delete the Poplach inventory and its test.
  - Make the package `private: true` and remove it from `scripts/release.ts`.
- **Acceptance.**
  - A health test: an environment with no dead letters reports `healthy`.
  - `release:validate` is green with 22 public packages.
- **Touch points.** `packages/operations/**` except `repositories/catalog.ts`, plus `scripts/release.ts`.

#### WU1.4 — IAM admin is bearer-only (S–M)

- **Problem.** The only browser path to `/admin/*` is Control's gateway, which sends a bearer
  (`control/src/iam-admin.ts:34-38`). The cookie branch of `resolveAdmin`
  (`iam/src/admin/router.ts:236-258`) and the `FABRIKA_IAM_ADMIN_ORIGINS` CSRF registry
  (`router.ts:129-158`) protect a path no caller uses. The no-credential local bypass
  (`iam/src/auth.ts:77-81`) is dead under `local:up`. `principals.delete`,
  `apps.getReturnOrigins` and `apps.clearReturnOrigins` have no production caller.
- **Scope.**
  - `resolveAdmin` accepts a registered-audience JWT or a `px_` key only.
  - Delete `ADMIN_ORIGINS` and its parsing and env wiring (Zerops installation env, deploy, compose),
    and delete the local bypass.
  - Remove the three procedures from IAM and `iam-contract`.
  - Keep `LOCAL_DEV_LOGIN`.
  - Update `iam/CLAUDE.md` and ADR-0022 where they name admission by `FABRIKA_IAM_ADMIN_ORIGINS`.
- **Acceptance.**
  - A test: an `/admin/*` request with only a session cookie gets 401.
  - `local:smoke` and `test:browser` are green.
- **Touch points.** `iam`, `iam-contract`, `provider-zerops/src/installation/{install-environment,deploy}.ts`, `local-stack` compose, ADR-0022, root `CLAUDE.md` (admission vocabulary).

#### WU1.5 — Docs and backlog cleanup (S–M)

- **Problem.**
  - `docs/INDEX.md` carries stale state ("twenty-two packages at 0.0.2", eight archived sprints in
    prose).
  - The 2026-09-23 readiness sprint is mostly done or superseded, and still cites the deleted engine.
  - About 8 backlog items are stale, belong elsewhere, or are not code work: 65, 75, 25, 11, 26, 34,
    22, 09. Re-check each before acting.
  - Some links are broken: 79 → 73, ADR-0025 → 58/59, `zerops-platform.md` → `sprints/…08-14`.
  - `zerops-platform.md` (1,366 lines) mixes platform facts with ~300 lines of Fabrika behaviour
    (`:613-733`, `:1097-1274`).
- **Scope.**
  - Cut INDEX to the folder map, active work and about 5 current bullets.
  - Rescope the readiness sprint to its open WU4–6, or turn them into backlog items and archive the
    sprint.
  - Delete or move the stale backlog items. Move oblaka and other-repo items out with a pointer.
  - Fix the broken links.
  - Move the Fabrika-behaviour sections of `zerops-platform.md` into `installing-on-zerops.md` and
    `provider-bundles.md`. Keep every measured fact.
  - Fix ADR-0025's "the proxy names a tag".
- **Acceptance.** No broken relative link under `docs/` outside `archive/` (scripted check), and
  `dprint check` passes.
- **Touch points.** `docs/**` except this sprint file and the ADRs other units rewrite.

### Wave 2 — protocol and credential cleanups (parallel)

#### WU2.1 — Operations catalog protocol (S)

- **Problem.**
  - Catalog response counts are produced (`operations/src/repositories/catalog.ts:115-164`),
    validated (`control/src/operations-catalog.ts:277-300`), and dropped.
  - `operationsCatalogDrift` (`operations-catalog.ts:348`) has no caller.
  - `…V1`/`…V2` type pairs and `protocolVersion` version a private channel between two services
    that ship together.
- **Scope.** Drop the counts, the drift helper, the version suffixes and `protocolVersion`. Keep the
  lease and the replay.
- **Acceptance.** Full suite with Postgres, and `local:smoke` (catalog sync after a kill) green.
- **Touch points.** `operations/src/repositories/catalog.ts` + contract types in `operations-contract`, `control/src/operations-catalog.ts`, `control/src/db/operations-*.ts`.

#### WU2.2 — Remove `issueJwt` and the delegated issuance surface (M)

- **Problem.** `issueJwt`, the delegated `issueKey`/`revokeKey` SDK modes, and `Iam.redeemKey` have no
  caller outside `auth`/`auth-core`/`iam`. The proxy's passthrough-JWT branch
  (`proxy-core/src/authorize.ts:193`) accepts only a token that `issueJwt` mints. `issueKey`'s
  service mode duplicates `apiKeys.provision`.
- **Scope.**
  - Delete `issueJwt` end to end: IAM handler, RPC, SDK client, proxy branch, `MAX_PASSTHROUGH_TTL`.
  - Remove `issueKey`/`redeemKey` from the app SDK and from `IamRpc`.
  - Keep the internal issuance that share links use (D1).
  - Keep the issuer's `revokeKey` that builder pairing calls (`control/src/api/builder-pairing.ts:60`).
  - Update ADR-0022 if it lists these.
- **Acceptance.**
  - Share-link create, use and revoke tests still pass.
  - The builder pairing revoke test passes.
  - `test:browser` and `local:smoke` are green.
- **Touch points.** `auth`, `auth-core`, `iam` (`issue.ts`, `rpc*.ts`), `proxy-core`, ADR-0022.

#### WU2.3 — Control small dead code and one origin check (S)

- **Problem.**
  - Zerops `REPO_EVENTS` and `GITHUB_WEBHOOK_SECRET` are dead (`control/src/zerops/runtime.ts:122-125`;
    the installation never sets the secret).
  - There are four same-origin checks: `origin-guard.ts:56`, `iam-admin.ts:84`,
    `operations-gateway.ts:59`, `source-connection/context.ts:27`. Only `origin-guard` handles
    `Sec-Fetch-Site` and `Origin: null`.
  - Small dead code:
    - the `replacements` option of `createControlRepositories` (test-only);
    - the `sourceConnection.status` RPC and `getConnection()`;
    - `decodeGitHubSourceConnectionListInput` (test-only);
    - `@fabrika/auth-core` listed in both deps and devDeps;
    - the pre-vault connection migration tests (`postgres-schema.test.ts:692-812`).
- **Scope.**
  - Delete the dead pieces.
  - Route all four call sites through `origin-guard`'s rule, the strictest one.
  - The IAM gateway treats only POST/PATCH/DELETE as state-changing (`control/src/iam-admin.ts:7`), so
    `PUT …/schema` skips the check; the shared rule uses a safe-method allowlist (GET/HEAD/OPTIONS). The IAM gateway's
    cookie-to-bearer swap stays explicit.
- **Acceptance.** Origin tests cover `Sec-Fetch-Site`, a `null` Origin and the Referer fallback for each
  gateway. The full suite is green.
- **Touch points.** `control/src/{zerops/runtime,origin-guard,iam-admin,operations-gateway,services}.ts`, `control/src/source-connection/**`, `control/src/repositories*`, `control-contract`.

#### WU2.4 — Drop the legacy namespace proxy `buildFromGit` path (S)

- **Problem.** ADR-0045 pins the namespace proxy to an uploaded `proxySource`, but `proxyBuildFromGit`
  and `FABRIKA_PROXY_SOURCE` remain (`provider-zerops/src/installation/topology/topology.ts:140,416`,
  `provider-zerops/src/namespace/{types,codec}.ts`, the CLI rejection at `cli/src/namespace.ts:178`).
- **Scope.** Delete the field, its codec branch, the topology env and the CLI rejection. A stored
  namespace without `proxySource` fails to decode (D2 of the first pass).
- **Acceptance.** Namespace tests and `gen:check` are green; `local:smoke` provisions a namespace.
- **Touch points.** `provider-zerops/src/{namespace,installation/topology}/**`, `cli/src/namespace.ts`, `platform-artifacts` (regenerate).

### Wave 3 — packages and the GitHub source

#### WU3.1 — Fold `email` into `iam` and `proxy-contract` into `proxy-core` (S)

- **Problem.** `@fabrika/email` (246 lines) has one consumer and one implementation.
  `@fabrika/proxy-contract` (98 lines) has consumers that need only zod.
- **Scope.**
  - Move email to `iam/src/email/`.
  - Move the manifest contract to `@fabrika/proxy-core/manifest`.
  - Update `release.ts`, tsconfig references, the root `CLAUDE.md`, ADR-0011/0022 package mentions,
    and the generated `platform-artifacts` imports.
- **Acceptance.** `release:validate`, `release:pack`/`smoke` (21 public packages), `gen:check`, and the full suite are green.
- **Touch points.** `email` (delete), `proxy-contract` (delete), `iam`, `proxy-core`, `proxy`, `platform-artifacts`, providers, `scripts/release.ts`.

#### WU3.2 — Cloudflare `resolveCommit` through the metadata client (M)

- **Problem.** `control/src/repo-source.ts:260-300,401-600` resolves a ref through the git-refs API,
  peels tags by hand and adds its own deadlines (~300 lines, ~430 test lines).
  `source/metadata.ts:110-118` does the same job with one `GET /commits/{ref}`.
- **Scope.**
  - Use `GitHubMetadataClient.commit`.
  - Move `safeRepositoryPath` and the tree-size constant out of `archive.ts` (it imports `node:crypto`),
    so `metadata.ts` is Worker-safe.
- **Acceptance.** Tests for a branch, a tag, an annotated tag, a missing ref, and a timeout pass on
  both runtimes' builds (typecheck the Worker entry).
- **Touch points.** `control/src/repo-source.ts`, `control/src/source/{metadata,archive}.ts`.

### Wave 4 — one GitHub model

#### WU4.1 — Cloudflare uses vault-backed GitHub connections (L)

- **Problem.** Cloudflare builds a single `GitHubAppRepoSource` from Worker secrets
  (`control/src/platform-cf.ts:78-102`), and its source connection is unavailable (`index.ts:37`).
  The result is two webhook modes (`services.ts:82-92`) and two app-binding modes
  (`api/registry/apps.ts:101-110`). `GitHubAppRepoSource.repositoryToken` (`repo-source.ts:340-400`)
  duplicates `vaultGitHubCredentials` (`source/credentials.ts:99`). Cloudflare creates its App at
  install time (`provider-cloudflare/src/installation/init.ts:557-622`).
- **Scope.**
  - Cloudflare Control gets its repository tokens from `vaultGitHubCredentials` and accepts connection
    management like Zerops.
  - The Cloudflare installation stops minting the App into Worker secrets. The operator connects
    GitHub from the console, as on Zerops.
  - Delete:
    - the `installation-only` binding;
    - the unscoped `/webhooks/github` route;
    - `REPO_EVENTS`;
    - `resolveInstallationId`;
    - `LocalGitHubRepoEvents`;
    - `StaticWebhookSecretProvider`;
    - the `GITHUB_APP_*` and `GITHUB_WEBHOOK_SECRET` Worker secrets and their workflow env.
  - Repo polling stays (D1).
  - Rewrite ADR-0029 to one model.
- **Verify first.** Check that the D1 schema already has the connection tables. If not, the unit adds a
  migration before WU6.1 squashes them.
- **Acceptance.**
  - A Cloudflare-runtime test registers a connection, binds an app to it, receives a scoped webhook,
    and resolves a token.
  - The full suite and `local:smoke` are green.
  - No real Cloudflare deploy is possible here; record it as unverified.
- **Touch points.** `control` (CF composition root, services, registry, repo-source), `provider-cloudflare/src/installation/**` (init, templates), `dashboard` (connection UI on CF), ADR-0029.

### Wave 5 — layout (parallel)

#### WU5.1 — Control GitHub modules under one `github/` directory (M)

- **Problem.** There are eight similarly named modules: `source/`, `source-connection/`,
  `source-connection.ts`, `github-connection/`, `github-connection-store.ts`, `repo-source.ts`,
  `repo-poll.ts`, `webhook.ts`. Some barrels only forward (`github-connection-store.ts`,
  `source-connection.ts`, `api/registry.ts`).
- **Scope.** Move the files into this layout, with no behaviour change, and delete the forwarding
  barrels:
  - `github/connections` — connection store, management, and credentials;
  - `github/source` — archive, transport, metadata, repo source;
  - `github/triggers` — webhook and poll.
- **Acceptance.** Typecheck and the full suite are green. `git diff -M` shows renames.
- **Touch points.** `control/src/**` (GitHub files), `control/CLAUDE.md`.

#### WU5.2 — One console package (M)

- **Problem.** `iam-ui` and `operations-ui` have one consumer, the dashboard, which carries:
  - 25 one-line route shims;
  - two hand-written `route-map.d.ts` files;
  - duplicated `Status`, `RouteError` and the formatters;
  - a backwards dependency: it imports `Icon`, `Modal`, `Table` and `ConfirmDialog` from `iam-ui`.

  `operations-ui/src/client.ts` is 100 lines; the other clients are about 15.
- **Scope.**
  - Move both packages into `dashboard/src/{access,operations}/`.
  - Delete the shims, route maps and duplicates.
  - Use a plain RPC client for Operations.
  - Add a `test` script to the dashboard, and move the `operations-ui` tests there.
- **Acceptance.** Dashboard build, typecheck, and `test:browser` are green.
- **Touch points.** `iam-ui` (delete), `operations-ui` (delete), `dashboard`, root tsconfig and scripts.

### Wave 6 — migrations

#### WU6.1 — Squash migrations and drop legacy adoption (M)

- **Problem.**
  - 44 Control, 22 IAM and 12 Operations migration files, including `*_legacy_*` and `*_retire_*`
    steps.
  - Legacy `schema_migrations` adoption remains: `platform-node/src/postgres-migrations.ts:22-50`,
    `:125-150` and `:275-310`, plus the `legacy:` blocks in the three `migrate.ts`.
  - About 44 tests cover legacy or backfill behaviour.
- **Scope.**
  - One `0001` per bundle and dialect, generated from the current schema.
  - Delete the adoption code and the legacy tests.
  - Keep the schema parity tests between D1 and Postgres.
  - Rewrite ADR-0017 (D2) and `control/DATABASE.md`.
- **Verify first.** Dump the schemas from a fresh `local:reset` before the change. After the change,
  diff them against a fresh dump: they must match (Postgres), and the D1 schema from `sqlite_master`
  must match too.
- **Acceptance.**
  - The schema dumps are identical.
  - Full suite with Postgres, and `local:reset && local:smoke` and `test:browser` are green.
- **Touch points.** `control`, `iam`, `operations` migrations and `migrate.ts`, `platform-node`, ADR-0017.
- **Owner action.** Reinstall the live test installations after this lands.

### Wave 7 — lint

#### WU7.1 — Lint for dead code (S)

- **Problem.** `noUnusedImports` and `noUnusedVariables` are off; turning them on reports 24 hits.
  `noExplicitAny` reports 37 hits, 31 of them in `canvas-kernel/src/engine/compiler.ts`.
- **Scope.** Enable the three rules and fix the remaining hits. Do not disable a rule per file.
- **Acceptance.** `bun run lint` is green with the rules on.
- **Touch points.** `biome.json`, the files the rules hit.

## Out of scope (explicit)

- Removing the builder, Cloudflare as a platform host, Operations, repo polling or share links (D1).
- Removing Operations `serviceKey` (D3).
- Collapsing `fake-zerops.ts` into the emulator; trimming `release.ts` (`example-pin`, registry backoff,
  `EXPECTED_PUBLIC_PACKAGES`); letting R2/Queues satisfy the ports directly; trimming the `app` RPC
  output builder; shared env helpers; dropping `ENVIRONMENT` from Control; folding `jwks` into
  `auth-core`. All were "maybe" in the review and are small.
- Simplifying catalog revision ordering and handoff passes (review "maybe"; backlog 84 holds it).
- Moving the builder or the canvas packages out of the repo (D6).

## Sequencing

| Wave | Units                             | Mode                                          |
| ---- | --------------------------------- | --------------------------------------------- |
| 0    | WU0.1                             | alone; touches imports across packages        |
| 1    | WU1.1, WU1.2, WU1.3, WU1.4, WU1.5 | parallel; disjoint territories                |
| 2    | WU2.1, WU2.2, WU2.3, WU2.4        | parallel                                      |
| 3    | WU3.1, WU3.2                      | parallel                                      |
| 4    | WU4.1                             | alone                                         |
| 5    | WU5.1, WU5.2                      | parallel                                      |
| 6    | WU6.1                             | alone; after every unit that changes a schema |
| 7    | WU7.1                             | last; lints the final tree                    |

Gates per unit: typecheck, the narrowest tests, then the full suite with Postgres before commit.
Units that touch delivery, auth or the console also run `local:reset && local:smoke` and, for the
console or IAM, `test:browser`. Run `release:validate`, `gen:check` and `release:pack`/`smoke`
whenever the package set changes.

## Run log

<!-- Append as you work. -->

- 2026-10-08 — Owner: the canvas packages stay here (D6 rewritten, old WU7.1 dropped).
- WU0.1: `uuidv7` leaves `auth-core` (it stays dependency-free); `iam` and `proxy-core` import it from `@fabrika/platform`.
- WU1.5 found the unused `proxyBuildFromGit` / `FABRIKA_PROXY_SOURCE` beside ADR-0045's `proxySource` pin (`provider-zerops/src/installation/topology/topology.ts:140,416`, `namespace/{types,codec}.ts`); added as WU2.4.
- Items handed out of this repo by WU1.5: the oblaka DO-migration-history bug (old 11), deprecating `@trasa/core` (old 26), retiring standalone Poplach (old 34), restricting npm token publishing on `@fabrika/*` (old 25, owner task).
- WU1.4 review: removing `apps.clearReturnOrigins` (no caller) leaves no API to clear a return-origin registry; `setReturnOrigins` refuses an empty set. Accepted.
- Wave 0–1 → `05bc9d2` (WU0.1), `def37c9` (WU1.2), `9b9aa3e` (WU1.3), `e4397c3` (WU1.1), `3386ed9` (WU1.4), `d966520` (WU1.5). Gates: typecheck, `bun run test` with Postgres 4094 + 317 + 180 pass / 0 fail, `gen:check`, `local:reset && local:smoke`, `test:browser` 10 pass.
- WU1.1: on an installation whose provider manages secrets, `apps.secrets.put` hands the value to the provider; the secrets list shows a ref only for vault rows (the provider contract cannot recognise its own refs). ADR-0004 retitled.
- Wave 2 → `c84c2a6` (WU2.2), `09b12c5` (WU2.4), `bdd7890` (WU2.1, release protocol included), `1a38d70` (WU2.3). Gates: typecheck, `bun run test` with Postgres 4068 + 317 + 180 pass / 0 fail, lint, format, `gen:check`, `release:validate`, `local:reset && local:smoke`, `test:browser` 10 pass.
- WU2.2 keeps `IamRpc.issueKey`: `fabrika control key issue` bootstraps machine keys through `/rpc/issueKey`.
- WU2.1 review: the release projection hash no longer matches rows stored before the change (a replayed revision would answer 409). Accepted under D2; WU6.1 and the reinstall reset the data.
- Left for WU5.1: `projectSingletonSourceConnectionPage` in `control-rpc.ts` is test-only.
- Wave 3 → `e314b93` (WU3.2), `fb4e2cb` (WU3.1, proxy-contract only). Gates: typecheck, `bun run test` with Postgres 3954 + 317 + 180 pass / 0 fail, lint, format, `gen:check`, `release:validate` (21 public packages), `release:pack` + `smoke`, `local:reset && local:smoke`, `test:browser` 10 pass.
- WU3.1: `@fabrika/email` stays a package — ADR-0019 and backlog 46 plan Operations alert email as its second consumer.
- WU3.2: ref grammar is now GitHub's (bare names follow git's resolution order, short SHAs resolve); `GET /commits/refs%2Fheads%2F…` and an annotated tag were checked against live GitHub. `GitHubAppConfig.apiBaseUrl` now only affects token minting; WU4.1 removes that path.
- Wave 4 → `b639797` (WU4.1, with `provider-contract` binding narrowed to `connection` and the manifest helpers removed from `installation-init`). Gates: typecheck, `bun run test` with Postgres 3890 + 317 + 180 pass / 0 fail, lint, format, `gen:check`, `release:validate`, `release:pack` + `smoke`, `local:reset && local:smoke`, `test:browser` 10 pass. `wrangler.jsonc` changed only by the removed `GITHUB_APP_ID` var.
- WU4.1 review: an existing Cloudflare installation keeps apps bound by installation id only (they stop deploying until rebound to a connection) and keeps the old `GITHUB_APP_*` Worker secrets (`wrangler deploy` does not delete secrets). Accepted under D2 — installations are reinstalled.
