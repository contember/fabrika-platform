> **OUTCOME — shipped 2026-08-21.** The account was emptied and one installation stood back up on
> the cheap defaults, unattended where the commands now allow it, and deployed two private
> applications from two GitHub organizations through their own keyed connections into one shared
> namespace. The rebuild found and fixed two platform facts the fake APIs had hidden (a missing
> service is a `400`, the unpacker needs directory entries) and shipped them as `v0.0.24` and
> `v0.0.25`. The two projects cost $8.70 and $3.98 per 30 days. Commit map: WU1a → `40fa310`
> (ADR-0037); WU0 → `30251be` (ADR-0038); WU2 → `da77242`; WU4 → `6fb69c5`; WU1 → `b1c0849`
> (ADR-0039); WU3 → `ee3ec4d`; WU5+6 → `e1976e5`; WU7 → `513aeae` (decided, not built); WU8 fixes →
> `c8e4d5d`, `9441c3d`; run log → `410cac3`, `a6169af`. Verification: after WU5+6 `bun run typecheck`
> 35/35, `bun test` 2 782 pass / 9 skip / 0 fail with PostgreSQL, lint and format clean,
> `release:validate` exit 0; CI and Release green on `v0.0.23`–`v0.0.25`; WU8 witnesses (1)–(8) in
> the run log. Backlog closed: 59, 60, 67, 68, 72, 73, 74 deleted; 65 re-pointed; 75 rescoped. Filed:
> 79–84. Deferred: backlog 75's synchronous preflight (now buildable with the token-introspection
> probe), the `registry-smoke` wait that is shorter than npm's replication lag, and backlog 84's
> cause — the first deploy of a freshly registered app can miss its Operations ingest.

# Sprint — a cheap installation, rebuilt from scratch (2026-08-21)

**Goal.** Delete every live Zerops project, remove the compatibility code their deletion makes dead,
fix the five defects that make a from-scratch bring-up expensive, and stand the installation back up
on the cheap defaults — one run that is simultaneously the live acceptance for all of it.

**Theme.** Both live projects — `fabrika-install-test` and `fabrika-notes-prod` — are artifacts of
exploratory sprints. They carry hand-set values nothing in this repository wrote, an app namespace
sized for a production that does not exist, and the only v1 source credential in the world. They cost
about $91 a month between them and prove nothing a fresh installation would not prove better.

The account is being emptied. That makes two things true at once. The legacy v1 compatibility path
becomes unreachable code, so it goes with the projects rather than lingering as an ungateable
promise. And the from-scratch path — proven once, on 2026-08-10, and never since — becomes the only
way back, so every defect that made that run expensive is worth fixing _before_ the rebuild, not
after.

The success condition is a platform bring-up an operator can run unattended — install, init, the
sidecar deploy and the first administrator — ending in a signed-in console, followed by an application
serving, on an installation whose idle floor is measured in single-digit dollars. Application
onboarding (a keyed source connection, registration) stays a hand sequence in this sprint; that is
[`78`](../backlog/78-register-a-zerops-app-from-local-config-in-one-command.md)'s work, not WU8's.

## Refs re-verified at HEAD (2026-08-21)

`✔` = confirmed at HEAD · `⚠` = a nuance the implementation must respect.

**The legacy surface**

- ✔ The split legacy env vars are `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` —
  `packages/provider-zerops/src/source-connection.ts:26` and `:27`. They produce the
  `legacy-complete` / `legacy-partial` inspection states at `:38`, `:39`, `:465` and `:466`.
- ✔ The unkeyed base bundle env is `GITHUB_APP_CREDENTIALS` —
  `packages/provider-zerops/src/source-connection.ts:25`. Keyed v2 slots are
  `GITHUB_APP_CREDENTIALS_V2_<sha256(connectionId)>`, derived in
  `packages/provider-zerops/src/source.ts:666-670`.
- ✔ `source` imports the base bundle and both legacy vars at boot —
  `packages/source-zerops/src/config.ts:34-47` — and `GitHubConnection` folds them into one legacy
  snapshot beside the keyed map, refusing a partial pair and a conflicting pair —
  `packages/source-zerops/src/github-connection.ts:122-138`.
- ✔ A keyed slot never falls back to the legacy one — `packages/source-zerops/src/github-connection.ts:418`.
  Removing the legacy snapshot therefore cannot silently redirect a keyed operation.
- ✔ Control carries `legacy-v1` as a transport kind in four places —
  `packages/control/src/run-lifecycle.ts:59`, `packages/control/src/source-connection-port.ts:13`,
  `packages/control/src/github-connection-store.ts:12` and `packages/control/src/db.ts:1581` — and
  derives it from `setupKind === 'adoption'` at `packages/control/src/source-connection.ts:812-813`.
- ✔ The generic webhook route is registered beside the scoped one —
  `packages/control/src/app.ts:44-45` — and both are `public` gates —
  `packages/control/fabrika.gates.ts:31-32`.
- ✔ The singleton compatibility row survives in both schemas:
  `packages/control/migrations/0019_github_source_connections.sql` and
  `packages/control/migrations-postgres/0015_github_source_connections.sql` both declare
  `github_source_connections` with `singleton INTEGER PRIMARY KEY CHECK (singleton = 1)`, and the
  keyed store still reads a `transport_kind = 'legacy-v1'` row at
  `packages/control/src/github-connection-store.ts:447`.
- ⚠ **`…V1` in a type name does not mean legacy.** `packages/provider-zerops/src/source.ts` uses the
  `V1` suffix as a MESSAGE version, and v2 responses reuse those types — `ZeropsSourceGitHubAppIdentityV1`
  is a field of the v2 activate response at `:77`, and `source.ts:437` and `:463` state outright that
  keyed operations are additive _so legacy client implementations remain valid_. This sprint removes
  the v1 **credential custody and webhook compatibility path**, not every symbol whose name ends in
  `V1`. Deleting by name would gut the live protocol.
- ⚠ A shipped migration file may not be edited or renamed — migration identity is `(bundle, filename)`
  ([ADR-0017](../decisions/0017-service-owned-postgres-migrations.md)). Dropping the singleton table
  is a NEW migration in both `migrations/` and `migrations-postgres/`, never a rewrite of 0019/0015.

**The five bring-up defects**

- ✔ Every `platform install` confirmation defaults to yes — `prompts.confirm(…, true)` at
  `packages/installation-zerops/src/install.ts:428`, `:518`, `:553`, `:577`, `:613` and `:622` — and
  nothing inspects whether stdin is a TTY, so a closed stdin walks the whole sequence.
- ✔ Each prompt opens and closes its own readline over `process.stdin` —
  `packages/installation-init/src/prompt.ts:177-180`, with `rl.close()` in a `finally` at `:172` —
  which is what discards buffered input between questions on a pipe.
- ✔ `InstallationCommand` is `'init' | 'install' | 'plan' | 'deploy'` —
  `packages/installation-contract/src/index.ts:10`. A first-administrator verb has to be added here
  or folded into `install`.
- ✔ The admin RPC input shapes still disagree: `PrincipalIdInput` keys on `id`
  (`packages/iam-contract/src/index.ts:338-340`) and is what `passwords.issueEnrollment` takes
  (`:455`), while `grants.create` takes `CreateGrantRequest` with `principalId` (`:459-460`).
- ✔ `mutateNamespace` discards `cause` and stores only `namespace ${mutation} failed` —
  `packages/control/src/api/namespaces.ts:171-181`. `cause` is not logged either, so nothing
  downstream can recover it.
- ✔ `createNamespace` and `reconcileNamespace` run the whole provider mutation inside the request —
  `packages/control/src/api/namespaces.ts:249-250` and `:312-313`.
- ✔ `ControlRpcContract.namespaces` exposes `list`, `get`, `plan`, `create`, `adopt`, `reconcile` and
  no removal — `packages/control-contract/src/rpc.ts:146-153`. `reconcile` takes `NamespaceIdInput`,
  so a stored target cannot be changed after creation either.

**The source transporter, being rewritten beside this plan**

- ✔ `source` packages from Git objects today: REST commit + recursive tree, `git init --bare` +
  `git fetch` into a temp dir, per-blob `git cat-file` into a tar on disk, gzip on upload —
  `packages/source-zerops/src/repository.ts` (~1 200 lines) and `github-metadata.ts`. The tar was
  always on disk; the "512 MB on one heap" belief that justified a RAM floor on `source` was wrong.
- ✔ Nothing on the control side reads `entryCount`, `expandedBytes` or an archive digest —
  `grep` over `packages/provider-zerops/src` and `packages/control/src` — so the archive need not be
  byte-deterministic.
- ⚠ ADR-0029's bold invariant says `source` "packages directly from Git objects". The rewrite amends
  it, so it carries its own ADR (0037) and ADR-0029 is not edited. WU0's and WU1's ADRs take the
  numbers after it.

**The cheap defaults, already landed**

- ✔ `3ecf86d` — namespaces default to `postgresql:single@18` at `oltp-hobby` and `corePackage: LIGHT`
  on every environment, the namespace proxy floors at one container, and the light tier's shared `db`
  moved to `oltp-hobby`. `bun test` 2528 pass / 162 skip / 0 fail; typecheck, lint, format and
  `render.ts --check` clean. **Not yet recorded as a decision** — WU0.

## Work units

### WU0 — Record the sizing decision and clear the dead backlog (effort S)

- **Problem.** `3ecf86d` changed a default that shapes every future installation's bill and rejected a
  real alternative (keep `prod` special, downscale per installation). Nothing in `decisions/` says so,
  and the reasoning lives only in a commit message. Meanwhile
  [`59`](../backlog/59-the-live-installation-calls-itself-local.md) and
  [`60`](../backlog/60-the-example-app-has-no-light-tier-descriptor.md) describe `fabrika-test`, which
  no longer exists on Zerops, and [`65`](../backlog/65-pin-a-zerops-build-to-a-revision.md) names it as
  its probe target.
- **Verify first.** `grep -rn "fabrika-test" .` across the whole repository, not only `docs/` — source
  comments cite docs and backlog items too.
- **Scope.** Write the ADR: namespaces are sized cheaply by default on every environment; a profile
  chooses the floor and the tuning preset, never the cap; HA and larger floors are an explicit act
  through `--postgres-type` / `--postgres-profile`. Record what it does NOT cover — the standard
  two-project platform tier keeps its HA databases. Delete backlog 59 and 60. Re-point 65's probe at
  whatever project WU8 creates. Update `backlog/README.md` and `INDEX.md`.
- **Acceptance / witness.** No file outside `archive/` mentions `fabrika-test` as a live target; the
  ADR is linked from `decisions/README.md`; `backlog/README.md`'s item list matches the files present.
- **Touch points.** `docs/decisions/0038-*.md` (0037 is WU1a's — confirm the next free number at
  write time), `docs/backlog/59-*.md`, `docs/backlog/60-*.md`, `docs/backlog/65-*.md`, `docs/backlog/README.md`,
  `docs/INDEX.md`.

### WU1a — `source` streams GitHub tarballs instead of packaging Git objects (effort M) · in flight

- **Problem.** The Git-object path costs ~1 560 lines, two git subprocess round-trips per job, twice the
  repository on disk, and a double read of the tree (REST, then git) — and the memory argument that
  justified a separate, RAM-floored `source` never held. A private deploy has not been exercised on a
  fresh installation since 2026-08-11; the next live run is WU8, so the simpler transporter must land
  before it, not after.
- **Verify first.** Confirm control's handling of a failed upload: ADR-0029 says every pre-trigger
  failure deletes the app version, which is what lets a validation failure abort an in-flight PUT.
- **Scope.** `resolve` = REST commit lookup + `contents/zerops.yaml` digest. `archive` = tarball
  endpoint → 302 to `codeload.github.com` only → gunzip → tar rewrite (strip the prefix, regular files
  only, reject symlinks / hard links / `.gitmodules` / traversal / duplicates, 50 000 entries and
  512 MiB enforced in the stream, descriptor digest checked in the stream) → gzip → PUT. No git, no
  temp disk, memory bounded to one header plus one pax record. The RPC contract with control, the
  upload-URL validation, the failure codes and the deadlines stay. ADR-0037 amends ADR-0029's
  packaging invariant; `docs/reference/zerops-platform.md` describes the new path.
- **Acceptance / witness.** Unit: `git archive`-generated fixtures round-trip through the rewrite and
  the captured PUT body unpacks to the expected paths, modes and content; symlink, `.gitmodules`, long
  pax path, oversize, truncated, wrong-prefix, traversal, foreign-redirect, descriptor-missing and
  descriptor-mismatch fixtures are refused with the existing codes. Live: WU8 item (4) is this unit's
  only end-to-end witness — record that the 302 target was `codeload.github.com` and that `source`
  ran with no git binary invoked and no disk growth.
- **Touch points.** `packages/source-zerops/src/{repository,github-metadata,service,config,index}.ts`
  and their tests, one comment in `packages/installation-zerops/zerops/setups.ts`,
  `docs/decisions/0037-*.md`, `docs/decisions/README.md`, `docs/reference/zerops-platform.md`.
  **WU1 edits `source-zerops/src/config.ts` too — WU1 starts after this unit is merged.**

### WU1 — Remove the legacy v1 source credential path (effort L)

- **Problem.** [ADR-0032](../decisions/0032-support-multiple-private-github-source-connections.md)
  kept the live v1 credential and the generic webhook as a marker-selected compatibility path, and the
  active [multi-connection sprint](sprint-2026-08-14-multiple-private-github-source-connections.md)
  still owes a live witness for it. That witness required the one v1 credential in existence —
  `GITHUB_APP_CREDENTIALS` on `source` in `fabrika-install-test`, confirmed present 2026-08-21 beside
  three keyed v2 slots. WU8 deletes the project. A compatibility path with no installation to be
  compatible with, and a gate that can never go green, is worse than no path.
- **Verify first.** Confirm no other installation holds a v1 credential — the account has exactly two
  Fabrika projects and the other is an app namespace with no `source` service. Then enumerate the real
  surface: every caller of the `legacy-complete`, `legacy-partial` and `durable` inspection states,
  every read of `transport_kind = 'legacy-v1'`, every route that resolves a connection without a
  connection id. Confirm the `transport_kind` CHECK constraint's exact values in both migration files
  before writing the drop.
- **Scope.** Delete, in dependency order: the split `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` import
  and its two inspection states; the unkeyed base bundle as an ACTIVE credential and the `adoption`
  setup kind that produces `legacy-v1`; the `legacy-v1` transport kind and every branch selecting on
  it; the generic `POST /webhooks/github` route and its gate, leaving only
  `/webhooks/github/:connectionId`; the singleton `github_source_connections` read path. Drop the
  singleton table in a NEW migration in both `migrations/` and `migrations-postgres/`. Then remove
  every symbol left with no caller — **by reachability, never by the `V1` suffix**, and rename nothing
  that survives.
- **Acceptance / witness.** The composed local fixture that currently seeds one legacy v1 plus two
  keyed v2 credentials seeds only keyed v2 and still passes; a request to `POST /webhooks/github`
  without a connection id is a 404, proved by a test; fresh and upgrade migrations pass on SQLite/D1
  and PostgreSQL, with the upgrade fixture exercising the FULL migration list (the trap
  `65bc44b` already fixed once); `grep -rn "legacy-v1\|GITHUB_APP_ID\b" packages/` returns nothing
  (`docs/archive/` may still mention them; `packages/` may not); public export tests still cover every surviving v2 symbol.
- **Touch points.** `packages/provider-zerops/src/{source,source-connection}.ts`,
  `packages/source-zerops/src/{config,github-connection}.ts`,
  `packages/control/src/{app,webhook,source-connection,source-connection-port,github-connection-store,run-lifecycle,db}.ts`,
  `packages/control/fabrika.gates.ts`, new `packages/control/migrations/00NN_*.sql` and
  `packages/control/migrations-postgres/00NN_*.sql`, `packages/dashboard/src/routes/settings/source.tsx`,
  their tests, and a superseding ADR for 0032's compatibility clause (0039 — after WU1a's 0037 and
  WU0's 0038). Starts after WU1a is merged: both rewrite `source-zerops/src/config.ts`.

### WU2 — Make stdin agree with each command's intent (effort S) · backlog [`68`](../backlog/68-platform-commands-mishandle-a-closed-stdin.md)

- **Problem.** The two commands that mutate a cloud account handle a non-interactive stdin in exactly
  the wrong directions. `install` walks its whole sequence — six generated secrets, an import, two
  deploy passes — with stdin closed, because every confirmation defaults to yes and an empty answer is
  indistinguishable from EOF (`install.ts:428`, `:518`, `:553`, `:577`, `:613`, `:622`). `init` cannot
  be driven by a pipe at all, because each prompt opens and closes its own readline
  (`prompt.ts:172`, `:177-180`) and closing one over a piped stdin discards what is already buffered.
  `init` is the command an operator is most likely to script; `install` is the one that must not be.
- **Verify first.** Reproduce both without writing code: `fabrika platform install --provider=zerops
  < /dev/null` against a project that does not exist (it must fail on the project, not on a prompt),
  and `printf 'a\nb\nc\n' | fabrika platform init --provider=zerops …` to watch it stop on question 2.
- **Scope.** `install` detects a non-interactive stdin and refuses, naming the flag that means "yes,
  unattended" — an explicit, auditable choice rather than a default. `init` reads every answer from
  ONE reader, or from flags, so a pipe drives it the way a terminal does.
- **Acceptance / witness.** `printf '…' | fabrika platform init --provider=zerops …` completes with no
  PTY; `fabrika platform install --provider=zerops < /dev/null` stops before it writes anything, and
  the message names the flag. Both are exercised, not asserted from a unit test with a fake prompt.
- **Touch points.** `packages/installation-init/src/prompt.ts`,
  `packages/installation-zerops/src/install.ts`, `packages/cli/`.

### WU3 — A command for the first administrator (effort S) · backlog [`67`](../backlog/67-command-for-the-first-administrator.md)

- **Problem.** `platform install` finishes by printing the provisioning key and the documented path
  stops there. Bringing the first administrator into existence on 2026-08-10 took four hand-made calls
  to `/admin/rpc` and an enrollment URL copied out of a terminal. Nothing in this repository does it
  and nothing tests that it still works — so after WU8 nobody can sign in to what was just built.
- **Verify first.** The two traps the hand run found are both still live at HEAD. The grant must be
  cross-app (`app: null`): grants filter to the calling app, so an `admin` grant scoped to the
  console's own app id leaves Delivery and Operations working and the Access plane refusing. And the
  input shapes disagree — `grants.create` takes `principalId` (`iam-contract/src/index.ts:459-460`)
  while `passwords.issueEnrollment` takes `PrincipalIdInput`, which keys on `id` (`:338-340`, `:455`),
  so the obvious call returns `400 id: Required`.
- **Scope.** A command, or a final step of `install`, that takes an email, is idempotent on re-run,
  writes a cross-app `admin` grant and prints an enrollment URL exactly once. Decide explicitly
  whether to harmonize the two admin RPC inputs or hide the difference in the command — a caller
  writing against the admin surface hits it either way, so record the choice. Seeding
  `IAM_BOOTSTRAP_ADMINS` is refused by decision: the Zerops path has no admission hatch precisely
  because nothing seeds one, and adding one would file
  [`64`](../backlog/64-close-the-bootstrap-admission-hatch-automatically.md) against ourselves.
- **Acceptance / witness.** Live, in WU8: on the fresh installation with `IAM_BOOTSTRAP_ADMINS` set
  nowhere — re-read off the running service to be sure — the printed URL sets a password and the
  resulting session reaches **all three** console planes, Access included.
- **Touch points.** `packages/installation-zerops/`, `packages/installation-contract/src/index.ts`
  (if a new verb), `packages/cli/`, `packages/iam-contract/` (only if the inputs are harmonized).

### WU4 — Namespace provisioning outlives its request (effort M) · backlog [`74`](../backlog/74-namespace-provisioning-outlives-the-request-that-asked-for-it.md)

- **Problem.** `createNamespace` and `reconcileNamespace` run the whole provider mutation inside the
  HTTP call (`api/namespaces.ts:249-250`, `:312-313`). On the live account the first namespace took a
  project import, a ~4½-minute proxy build and a subdomain publication, and every attempt ended in a
  502/504 with a non-JSON body — so the typed RPC client reported a transport fault rather than a
  result, control kept working after the client was gone, and the row was left `failed` even though
  the provider had made real progress and checkpointed it. The console's create form awaits the same
  call. WU8 creates a namespace; without this, WU8's own witness is a timeout.
- **Verify first.** `triggerDeploy` already models the answer — it creates a `pending` run and
  enqueues it (`packages/control/src/api/runs.ts:250`) precisely so a trigger is durable. Read that
  path before designing a second one; the namespace lifecycle already checkpoints, so the missing
  piece is the trigger boundary, not the state machine.
- **Scope.** The mutation becomes asynchronous behind the existing queue: the request returns the row
  in a non-terminal state, work proceeds outside the request, and the caller polls `get`. Keep the
  provider lifecycle and its checkpoints exactly as they are.
- **Acceptance / witness.** Live, in WU8: `namespaces create` returns inside a normal HTTP timeout
  with a non-terminal state, the console shows it progressing, and the namespace reaches `ready`
  without the caller having stayed connected.
- **Touch points.** `packages/control/src/api/namespaces.ts`, `packages/control/src/run-lifecycle.ts`,
  `packages/control-contract/src/rpc.ts`, `packages/dashboard/`.

### WU5 — A failed namespace says what failed (effort S) · backlog [`72`](../backlog/72-a-failed-namespace-reports-nothing-an-operator-can-act-on.md)

- **Problem.** `mutateNamespace` catches everything, throws away `cause` and stores a message naming
  only the operation (`api/namespaces.ts:171-181`). `cause` is not logged either, so nothing
  downstream can recover it. Three genuinely different live failures — a `403 insufficientPermissions`
  on project import, a `400 invalidUserInput` on a service-variable write, and a
  `serviceStackIsNotHttp` on subdomain publication — all surfaced as the same
  `namespace provision failed` with the same 502, and each took a hand-written reproduction to
  identify. WU8 will hit at least one of these.
- **Verify first.** Establish what a provider error actually carries before designing the projection,
  and confirm no path puts a credential in one — the invariant is that a clone URL with an embedded
  token must never reach a log or a row.
- **Scope.** Preserve the provider's failure as something an operator can act on: a stable code plus a
  redacted message on the row, and the full cause logged. Redaction is required, discarding is not a
  substitute for it.
- **Acceptance / witness.** Three synthetic provider failures of different classes produce three
  distinguishable `lastError` values and three distinguishable console renderings; a credential-shaped
  value injected into a provider error appears in neither the row nor the log.
- **Touch points.** `packages/control/src/api/namespaces.ts`, `packages/control-contract/`,
  `packages/dashboard/`.

### WU6 — A failed namespace can be removed (effort S) · backlog [`73`](../backlog/73-a-failed-namespace-cannot-be-removed.md)

- **Problem.** The contract has no removal (`control-contract/src/rpc.ts:146-153`), so a namespace
  whose provisioning failed holds its id forever: `createDeploymentNamespace` refuses a duplicate id
  with 409, a retry must invent a new name, and provisioning may already have created a real project
  whose marker-based recovery is keyed to the ORIGINAL id — so a second id strands the first project
  rather than reusing it. In a rebuild, the first namespace attempt is exactly the one most likely to
  fail.
- **Verify first.** Confirm the resource-claim and `app_envs` foreign keys that a delete must respect —
  `packages/control/migrations-postgres/0005_deployment_namespaces.sql` declares
  `ON DELETE RESTRICT` on both.
- **Scope.** Removal for the narrow case only: a namespace with no registered app environments,
  refused while any app references it. It removes the ROW and releases the id; it does NOT delete a
  provider project the failed provisioning may have created — that is a destructive act on live state,
  and the operator is told the project's id so they can delete it by hand. Decided here so WU8 does not
  decide it under pressure. Deleting a READY namespace that hosts running applications is likewise
  out of scope.
- **Acceptance / witness.** A namespace that never reached `ready` and owns no app environment is
  removed, its id is immediately reusable by a create under the same name, and a namespace with an app
  environment refuses removal with a message naming the app.
- **Touch points.** `packages/control-contract/src/rpc.ts`, `packages/control/src/api/namespaces.ts`,
  `packages/control/src/db.ts`, `packages/dashboard/`, `packages/cli/`.

### WU7 — Name the missing token capability before it fails (effort S) · backlog [`75`](../backlog/75-a-running-installation-keeps-a-token-that-cannot-create-projects.md), rescoped

- **Problem.** An integration token's grants are fixed at mint time, so a token minted before
  [ADR-0034](../decisions/0034-the-control-plane-creates-the-projects-it-owns.md) cannot acquire
  `canCreateProjects` later and fails the first `namespaces create` with `403 insufficientPermissions`
  on project import. **Deleting both projects makes the repair half of this item moot for this
  account** — WU8 mints a fresh token that already carries the flag. What survives is the diagnosis:
  the failure is currently reported as a bare `namespace provision failed`, so an operator has nothing
  to connect a release note to.
- **Verify first.** Confirm `platform install` mints with `canCreateProjects` at HEAD —
  `packages/installation-zerops/src/install.ts`, `createIntegrationToken` in
  `packages/provider-zerops/src/api.ts`. If it does not, this unit grows and WU8 blocks on it.
- **Scope.** A preflight in `namespaces create` that names the missing capability before anything is
  provisioned. The in-place re-mint verb is dropped from this sprint — with no pre-ADR-0034
  installation left, it would ship untested. Rewrite backlog 75 down to the re-mint half, or delete it
  if WU5's error projection already names the capability well enough; decide with the evidence, not in
  advance.
- **Acceptance / witness.** A token without the flag is told so by name, before the first mutation,
  and the message says how to fix it. Exercised against a deliberately under-granted token, not a fake.
- **Touch points.** `packages/provider-zerops/src/namespace.ts`, `packages/control/src/api/namespaces.ts`,
  `docs/backlog/75-*.md`.

### WU8 — Delete both projects, stand one back up cheaply (effort L)

- **Problem.** Everything above is unproven until an installation exists that was built by it. The
  from-scratch path last ran on 2026-08-10 and found five defects in shipped code that had unit tests
  against fake APIs and had never been executed. Nothing since has re-run it.
- **Verify first.** Before deleting: the three organization-owned GitHub Apps live on GitHub and
  survive, but their private keys live only as `GITHUB_APP_CREDENTIALS*` on the `source` service and
  die with it — plan to generate a fresh private key per App rather than recreating the Apps. Control's
  database is the light tier's shared `db` and dies with the project, taking the app registry, the
  namespace targets, the vault and the run history. While the old token still exists, probe whether any Zerops endpoint reads a token's own
  capabilities (`canCreateProjects`) and record the answer in `reference/zerops-platform.md` — backlog
  75's synchronous preflight depends on it. Confirm nothing else is wanted off the account
  first; after this there is no live evidence base until the rebuild lands.
- **Scope.** Delete `fabrika-notes-prod` and `fabrika-install-test`. Create one empty project. Run
  `platform install` → `platform init` → the sidecar's CI deploy → the WU3 first-administrator command,
  unattended where WU2 now permits it. Register the example application, create its namespace through
  the WU4 asynchronous path, and deploy it from a private repository through a keyed v2 connection.
  Read the resulting resource floor back off the account.
- **Acceptance / witness.** Recorded with redacted identifiers and timestamps: (1) `install` refuses a
  closed stdin and `init` completes from a pipe with no PTY; (2) the printed enrollment URL produces a
  session reaching all three console planes with `IAM_BOOTSTRAP_ADMINS` set nowhere, re-read off the
  running service; (3) `namespaces create` returns inside a normal timeout and the namespace reaches
  `ready` with the caller disconnected; (4) a private repository resolves, uploads, builds and serves,
  with `/healthz` 200 — through WU1a's tarball path: the redirect target was `codeload.github.com`,
  no git binary ran on `source`, and its disk did not grow; (5) `zops scale get` on every service shows the cheap floors this sprint's
  defaults declare, and the project's reported 30-day cost is single-digit dollars; (6) no service
  carries an autoscaling value fabrika did not write — the hand-set 1 GB floor on `source` must not
  reappear. (7) A private repository owned by a SECOND connected organization deploys through its own
  keyed connection — the witness the archived multi-connection sprint (2026-08-14) never collected. (8) Against a deliberately under-granted integration token, `namespaces create` returns
  `pending` and the row fails with `lastErrorCode: insufficientPermissions` and the platform's message,
  with no project created — the live witness of WU5's projection, which is what WU7 settled on.
- **Touch points.** No repository files. WU8 changes authorized live Zerops and GitHub state and
  returns redacted witness facts to WU0 for the run log. No credential value enters that report.

## Out of scope (explicit)

- **The production two-project topology and custom domains** —
  [`05`](../backlog/05-bring-up-on-a-real-zerops-account.md) items 1 and 2. This sprint rebuilds the
  light tier. The standard tier's HA databases are deliberately untouched by `3ecf86d` and stay that
  way until someone applies that topology and measures it.
- **The L7 balancer client-address probe** — [`05`](../backlog/05-bring-up-on-a-real-zerops-account.md)'s
  open semantics. It needs a live project, so it becomes cheap the moment WU8 lands; it is not a
  prerequisite for WU8.
- **Pinning what Zerops builds** — [`65`](../backlog/65-pin-a-zerops-build-to-a-revision.md). WU0
  re-points its probe target; settling it is its own work.
- **Closing the Cloudflare bootstrap hatch** — [`64`](../backlog/64-close-the-bootstrap-admission-hatch-automatically.md).
  The Zerops path avoids it by not having one, and WU3 must not introduce one.
- **Changing a namespace's stored target after creation.** Discovered while pricing `fabrika-notes-prod`:
  `namespaces.reconcile` takes only `NamespaceIdInput`, so a declared postgres type or profile cannot
  be changed without editing `deployment_namespaces.provider_target_json` directly, and
  `validateService` throws when the live service disagrees. File it as a backlog item in WU0; do not
  solve it here.
- **Merging the four Bun services.** Raised and rejected on 2026-08-21: four runtimes floor at four
  shared cores and 0.5 GB together, so merging would save about three shared cores and cost the
  credential-custody boundary ([ADR-0029](../decisions/0029-an-operator-owned-github-app-delivers-zerops-sources.md)),
  the telemetry availability boundary ([ADR-0016](../decisions/0016-independent-operations-plane.md))
  and the identity boundary. The cost was never the service count.

## Decisions

1. **The legacy v1 path dies with the account, rather than surviving as an ungateable promise.** The
   alternative — keep the compatibility code and close the multi-connection sprint with its live gate
   unmet — leaves code nobody can exercise and a sprint that cannot honestly be archived. Requires a
   superseding ADR for
   [ADR-0032](../decisions/0032-support-multiple-private-github-source-connections.md)'s compatibility
   clause; 0032 is immutable and is not edited.
2. **Fix before rebuild, not after.** Every WU2–WU7 defect is on the bring-up path, and WU8 is their
   only honest acceptance. Rebuilding first would mean either living with them again or tearing down
   twice.
3. **Delete by reachability, never by the `V1` suffix.** The suffix is a message version and v2 reuses
   several of those types (`source.ts:77`, `:437`, `:463`).
4. **The gap between the deletion and the rebuild is the risk to manage.** The from-scratch path works
   today and nothing re-proves it while the account is empty. Deletion is NOT pulled forward to save
   the bill — the two projects cost about $3 a day, less than a second teardown. If WU1–WU7 are not
   merged by **2026-08-28**, run WU8 from HEAD with whatever has landed, record which units it did not
   witness, and re-run only their live acceptance later, rather than staying dark or tearing down twice.

## Sequencing

| Stage | Units                       | Notes                                                                                                                                                  |
| ----- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1     | WU0 ∥ **WU1a**              | Independent of each other. WU1a is already in flight; WU0 is docs only.                                                                                |
| 2     | **WU1** ∥ **WU2** ∥ **WU4** | The two long poles start here. WU1 waits for WU1a (shared `config.ts`); WU4 is the riskiest design change on WU8's path, so it no longer waits on WU5. |
| 3     | **WU3** ∥ WU5 → WU6         | WU3 needs WU2's prompt decision; WU5 and WU6 both touch `api/namespaces.ts` after WU4 — run them in that order, not in parallel.                       |
| 4     | WU7                         | Cheapest after WU5, whose projection may already carry the message.                                                                                    |
| 5     | **WU8**                     | The live run. Everything above is unproven until this passes.                                                                                          |

WU1 and WU4 are the long poles. WU1 is independent of WU2–WU7 but not of WU1a; WU4 is independent of
everything except WU6, which follows it.

## Run log

<!-- Append as you work: discoveries, deviations, blockers. Graduate each entry:
     changed the *why* → ../decisions/NNNN ; new future work → ../backlog/NN ;
     transient → leave it (dies with the sprint on archive). After graduating,
     trim to a one-line pointer ("→ ADR-0007"). -->

- 2026-08-21 — Plan written. `3ecf86d` already landed the cheap defaults; WU0 owes its ADR. Live state
  at planning time: `fabrika-notes-prod` at about $78/30d (an HA PostgreSQL at `oltp-production`, six
  dedicated cores and 12 GB at rest for one example app) and `fabrika-install-test` at about $13.25/30d.
  `source` on `fabrika-install-test` carries `GITHUB_APP_CREDENTIALS` plus three keyed v2 slots —
  confirmed by key name only, no value read — which is the evidence WU1 acts on. `fabrika-test` was
  already gone from the account before this sprint began.
- 2026-08-21 — WU1a added: the `source` tarball rewrite was decided and started the same day this plan
  was written (ADR-0037). WU0's ADR moves to 0038 and WU1's to 0039. WU4 moved up to stage 2 and WU5
  down to stage 3 so the two long poles start together. WU6 now decides the provider-project question
  (it does not delete one). Decision 4 got a date.
- 2026-08-21 — WU1a landed locally in `40fa310`: `source-zerops` 127 pass / 0 fail, full typecheck,
  lint and format clean. Not yet exercised against a live GitHub tarball — WU8 item (4) stays its
  witness. WU1 may start.
- 2026-08-21 — Wave 1 landed: WU0 `30251be`, WU2 `da77242`, WU4 `6fb69c5`, WU1 `b1c0849`, WU3 `ee3ec4d`.
  Gate after WU1: `bun run typecheck` 35/35, `bun test` 2 733 pass / 9 skip (S3 only) / 0 fail with a
  dedicated PostgreSQL 17, lint and format clean. Each unit had an independent review and one fix round.
  Deviations from the plan text, all deliberate: (a) the generic `POST /webhooks/github` route and gate
  STAY — the Cloudflare composition is configured with exactly that URL; a Zerops composition refuses it
  with 401, so WU1's "404" and "grep returns nothing" acceptance read as "401 on Zerops" and "`legacy-v1`
  only in shipped migrations"; `GITHUB_APP_ID`/`GITHUB_APP_PRIVATE_KEY` are the Cloudflare static-secret
  path and were never legacy. (b) WU4 writes `pending` from the request and claims `pending →
  provisioning` in the worker; a reconcile never rewrites `provider_target_json`; the Bun consumer is
  sequential, so a namespace job delays deploys queued behind it — accepted, the second-queue change is
  out. (c) WU2's `install` flag is `--yes`; a TTY keeps one readline per question (a persistent one
  leaves the terminal raw for `git`/`gh` spawned between questions), a pipe gets one queued reader.
  (d) WU3 is a new verb `platform admin` with a required `--iam-host` and an opt-in `--reissue`; its
  contract test against the real IAM router showed a duplicate cross-app grant answers 500 — a latent
  IAM defect worth its own item. (e) The local smoke cannot exercise a bound private deploy without a
  GitHub double (backlog 81); it now proves the scoped webhook signature and triggers the example
  deploy through the API. The 2026-08-14 sprint is archived; its second-organization deploy is WU8 (7).
- 2026-08-21 — WU5+6 landed as one unit in `e1976e5` (shared files: `api/namespaces.ts`, the contract,
  the namespace console). WU7 decided with the evidence: no introspection endpoint for a token's
  capabilities is recorded, so a synchronous preflight cannot be built or tested without a live probe;
  WU5's projection already names `insufficientPermissions` at the first call with nothing created.
  Backlog 75 is rewritten down to the re-mint half; WU8 gains item (8) and a verify-first probe for the
  endpoint. Backlog 82 records the IAM 500 on a duplicate cross-app grant found by WU3's contract test.
  Gate after WU5+6: typecheck 35/35, `bun test` 2 782 pass / 9 skip / 0 fail with Postgres, lint and
  format clean. Everything before WU8 is done; WU8 is the operator's live run.
- 2026-08-21 — WU8, first half, run from this machine after `v0.0.23` (Release green; the sidecar pins
  it). Empty project `fabrika-test2` created through `CreateProject` with `envIsolation: service`
  (`zops project create` has no such flag). Witnesses so far, identifiers redacted where they are
  credentials: (1) `install < /dev/null` refused, exit 1, naming `--yes`; `install --yes` ran
  unattended to `install exit 0` with every confirmation logged `yes (--yes)`, five services ACTIVE;
  `printf … | init` drove every question from the pipe with no PTY, created
  `contember/fabrika-zerops-test2`, wrote the Environment and triggered the workflow, which deployed
  green. (2) `platform admin` invited the principal, wrote the cross-app `admin` grant and printed one
  URL; a re-run reported the existing principal, grant and outstanding enrollment and issued nothing.
  The URL set a password and the session reached Applications, Users and Errors; `IAM_BOOTSTRAP_ADMINS`
  is set on no service (read back off all five). (3) `namespaces create --preset=cheap` answered
  `pending` in 0.12 s; the namespace reached `ready` 6.5 minutes later with no client attached, and
  control created the `apps-test2` project itself. (5)(6) Every runtime floors at 1 shared core /
  0.125 GB / 1 container (proxy 1–2 on the platform, 1–6 in the namespace); `db` and the namespace
  `postgres` are `oltp-hobby` at 0.25 GB; no service carries a value fabrika did not write — the old
  1 GB floor on `source` is gone. The 30-day cost is not yet readable on projects minutes old.
  (8) With control's token swapped for a deliberately under-granted one (no `canCreateProjects`),
  `create` answered `pending` and the row failed with `lastErrorCode: insufficientPermissions` and the
  platform's own message; no project was created. Then `namespaces remove` freed the id, `create`
  reused it at once, and a second `remove` cleaned up; the original token was restored and
  `reconcile` reached `ready` again. The verify-first probe found the introspection endpoint backlog
  75 needed (reference doc updated). Open: (4) the private deploy and (7) the second organization
  need a GitHub App connection, which only the console's manifest flow can create — the operator's
  step. Leftover on the account: the old `fabrika-install-test` integration token still exists with
  `canCreateProjects` and no projects.
- 2026-08-21 — WU8, second half: the private deploy, which found two defects the fake APIs had hidden
  and shipped two patch releases. The operator connected the organization's GitHub App through the
  console. `register` then answered `502 provider registration preparation failed` in 30 ms, with
  nothing in control's log: the platform answers a missing service by name with `400
  serviceStackNotFound`, `findService` matched only a 404, and the registry swallowed the cause. Fixed
  in `c8e4d5d` (code-based check, emulator mirrors the 400, registry logs the reason; response stays
  opaque as its test pins) and rolled out as `v0.0.24` through the sidecar. `register` then resolved the
  connection from the organization and imported the app service. The first deploy failed in one
  second: a proxy target needs a `domain`, which registration had accepted without (backlog 83); set
  to one of the namespace proxy's `zerops.app` hosts through `apps environments put`. The second deploy
  resolved, uploaded and built — and `BUILD_FAILED` 45 s in with no line after "unpacking" and no
  reason on the app version or process. The same tree pushed with the CLI deployed. Three hand uploads
  isolated it: regular files only fails, the same files with one directory entry per parent deploys,
  the fixed rewrite's archive deploys — the platform's unpacker creates no directory it was not told
  about, and the first tarball rewrite dropped them. Fixed in `9441c3d` (parents derived from file
  paths, written once, outermost first), `v0.0.25`, sidecar rolled. (4) The third run succeeded:
  `apply-import → trigger-deploy → await-deploy (WAITING_TO_BUILD → BUILDING → DEPLOYING → ACTIVE) →
  reconcile-schema`, 3 minutes end to end, from the PRIVATE example repository through the keyed v2
  connection; `/healthz` through the namespace proxy answers 200 and `/` the gate's 302. The
  redirect target is pinned to `codeload.github.com` in code and the same code path against the same
  commit showed it locally; `source` spawns nothing (zero subprocess references) and stages nothing
  on disk, so there is no disk to grow. Both platform facts are in `reference/zerops-platform.md`.
  Also observed twice: the Release's `registry-smoke` fails on `@fabrika/control-contract` because
  npm shows the published version about five minutes late while the other 22 packages are visible
  within seconds; re-running the job passes (publish is idempotent). Open: (7) the second
  organization still needs its own GitHub App connection; the 30-day cost is still unreadable.
- 2026-08-21 — WU8, close. (5) The account now reports the 30-day cost of current resources:
  the platform project $8.70 (6 shared cores, 1.5 GB RAM, 6 GB disk) and the namespace project $3.98
  (3 shared cores, 0.625 GB RAM, 3 GB disk) — single-digit dollars each, as the acceptance asked.
  (7) The operator connected a SECOND organization through the console (its own GitHub App, installed
  on the whole organization). A private repository there (a copy of the example with a
  shared-namespace-conformant id and hostname — the first attempt with a hyphenated id was refused by
  the prefix rule at registration, correctly) registered through that organization's own connection
  and installation, and deployed into the same namespace beside the first app: resolve, upload, build,
  deploy, `ACTIVE`, `reconcile-schema`. Its first two deploys failed at start for want of the
  Operations-managed environment, which a later catalog change supplied (backlog 84). Follow-ups
  filed: backlog 83 (a proxy target registers without the domain its deploy needs), backlog 84. Left
  on the account deliberately: the two throwaway projects, the second organization's test repository,
  the `sprint-wu8` machine key (24 h), and the old `fabrika-install-test` integration token — the
  operator's call. Every acceptance item (1)–(8) is recorded above.
