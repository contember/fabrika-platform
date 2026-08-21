<!--
On close, prepend an OUTCOME block here, then `git mv` this file to ../archive/:

> **OUTCOME — shipped YYYY-MM-DD.** <one-paragraph result.> Commit map: WU1 → <sha>,
> WU2 → <sha>, … Verification: <the gate command + numbers>. Backlog closed:
> <ids deleted/rescoped>. Deferred: <honest notes>.
-->

# Sprint — a bring-up without surprises (2026-08-21)

**Goal.** Make the next from-scratch Zerops bring-up a sequence of commands that each say what they
need, refuse early when it is missing, and leave evidence an operator can read — instead of the run
the [cheap rebuild](../archive/sprint-2026-08-21-cheap-rebuild-from-scratch.md) just finished, which
worked but only with an operator reading source, calling raw APIs and guessing at silence.

**Theme.** The rebuild's run log lists every place the tooling was quiet or wrong: two platform facts
the emulator contradicted (found only by deploying), a catalog sync that skipped a new app without a
line in any log, a registration that accepted an environment its deploy could not serve, a project
that had to be created by hand through a raw API, a machine-key command whose help named the wrong
origin, a release check shorter than npm's replication lag, a build-log relay that mixes app versions,
and a 20-minute roll for every patch. Each item below removes one of those, and every one is witnessed
by a test or by the same live account — the sprint closes when a second operator, following only the
printed output, reaches a deployed application without opening a source file.

## Refs re-verified at HEAD (2026-08-21)

Re-read the load-bearing facts in the actual code before planning on them.
`✔` = confirmed live · `⚠` = drift/nuance caught.

- ✔ The emulator diverged from the platform twice in one day and both divergences were fixed by
  hand-writing the live shape into it (`c8e4d5d`, `9441c3d`); nothing checks the emulator against
  the account. The reference doc carries 14 `### Verified live` sections, every one a manual run —
  `docs/reference/zerops-platform.md`.
- ✔ A coalesced catalog sync returns silently — `packages/control/src/operations-catalog.ts:69`; only a
  failure warns (`:83`); the lock TTL is 5 minutes (`:17`); the deploy reads the ingest config and
  proceeds without it when absent, saying nothing — `packages/control/src/run-lifecycle.ts:424-434`;
  the maintenance replay runs every 5 minutes — `zerops.yaml:235`.
- ✔ `platform deploy` walks `PLATFORM_DEPLOY_ORDER = ['iam', 'operations', 'source', 'proxy', 'control']`
  and deploys one service at a time — `packages/installation-zerops/src/deploy.ts:67`, `:518-521`; the
  file's header explains the one ordering property that matters (every write before every deploy;
  the proxy before the service whose gates widened). Whether `iam`, `operations` and `source` may
  build concurrently is not stated anywhere.
- ✔ `platform install` requires an existing project (`--project-id`) and reads it —
  `packages/installation-zerops/src/install.ts:302`; it already mints an integration token with
  `canCreateProjects: true` (`:580-587`), so the operator's personal token can create projects. The
  project's `envIsolation` is applied per service by the import (`docs/reference/zerops-platform.md:34-37`),
  so project creation itself needs only a name, a client id and `mode: LIGHT`.
- ✔ `fabrika control --help` still says `--core-package … defaults to SERIOUS for prod`
  (`packages/cli/src/control.ts:63`; stale since ADR-0038) and calls `FABRIKA_IAM_RPC_URL` "IAM's own
  origin" (`:89`) — the live run needed IAM's PUBLIC origin, and `http://iam:3000` is unreachable from
  an operator's machine.
- ✔ A proxy target with no `domain` registers and fails at deploy —
  `packages/control/src/node/zerops-proxy.ts:48`; the namespace presentation lists no serviceable host —
  `packages/provider-zerops/src/namespace.ts:506-531` (backlog 83).
- ✔ The registry smoke retries 6 × 2 s — `scripts/release.ts:539-541`; npm showed
  `@fabrika/control-contract` about five minutes after publish on both `v0.0.24` and `v0.0.25`.
- ✔ The build-log relay reads by `serviceStackId` and `limit` only —
  `packages/provider-zerops/src/api.ts:1255`; the run log of the first successful deploy carried boot
  lines stamped from three earlier app versions (`packages/provider-zerops/src/provider.ts:184-199`).
- ⚠ The rebuild's "no readiness endpoint" friction was the operator's error, not a gap: control's
  `/healthz` is a public gate — `packages/control/fabrika.gates.ts:29`. Not in scope.
- ✔ The public example repository still pins `@fabrika/*` at `^0.0.4` on `main`; the rebuild deployed
  from a branch that bumped it by hand.
- ✔ The `source` service's memory during a streamed upload was never read: the rebuild proved the
  stream deploys at a 0.125 GB floor, not how much it uses.

## Work units

### WU1 — One table of platform facts, checked against the account and the emulator (effort M)

- **Problem.** The emulator encodes what someone believed about Zerops. Twice in one run it was wrong
  in a way unit tests could not see (`service-stack-by-name` answers `400 serviceStackNotFound`; the
  unpacker creates no parent directory), and both were found by a failed live deploy. Every "Verified
  live" section in the reference doc was produced by hand and re-verified by nobody.
- **Verify first.** List the facts in `docs/reference/zerops-platform.md` that a client's behaviour
  depends on and that a token with one throwaway project can probe without side effects beyond that
  project: the by-name 400, the `user-data` LIST 400, the import "accepted and silently dropped"
  cases, subdomain establishment, a user-data write being a process, the `env` reading shape. Note
  which need a deployed service (the unpacker probe needs a build) and cost minutes.
- **Scope.** (1) A `platform-facts` fixture table — one entry per fact: request shape, expected
  status and code, the reference section it came from. (2) An opt-in live suite that runs the table
  against a real account behind `FABRIKA_LIVE_ZEROPS_TOKEN` + `FABRIKA_LIVE_ZEROPS_PROJECT_ID`, skipping
  cleanly with the same "here is what to set" message the Postgres suites print, creating only
  throwaway services named with a run id and deleting them after. (3) The emulator's tests consume
  the SAME table, so a fact added for the platform is asserted of the emulator in the same change.
  (4) The unpacker probe (regular files only → `BUILD_FAILED`; with directories → `ACTIVE`) as the
  one slow, opt-in case. (5) A short section in the reference doc naming the suite as the way a fact
  becomes "verified".
- **Acceptance / witness.** `bun test` without the variables: the live suite skips and says why. With
  them, against the account: every table row passes; the two facts that bit the rebuild are rows. A
  deliberately wrong row (say, expecting 404 from by-name) fails BOTH the live suite and the emulator
  test — the negative control that proves the two read one table.
- **Touch points.** `packages/local-stack/src/zerops-emulator.ts` and its tests,
  `packages/provider-zerops/src/__tests__/` (or a new `tests/live/` at the root — decide in Verify
  first by where the fixture can be imported from both sides without a new package), `package.json`
  scripts, `docs/reference/zerops-platform.md`, root `CLAUDE.md` (the skip-cleanly list).

### WU2 — The catalog sync says what it did, and a deploy says what it lacked (effort M) · backlog [`84`](../backlog/84-the-first-deploy-after-registration-can-miss-its-operations-ingest.md)

- **Problem.** A freshly registered app deployed twice without its Operations-managed environment while
  Operations already listed it; a later catalog change fixed it; no log line anywhere explains which.
  `runCatalogSync` returns `coalesced` silently, `flushCatalog` logs nothing on `applied`, and the
  deploy treats an absent ingest config as "nothing to inject".
- **Verify first.** Reproduce in the control test suite with the real catalog code and a fake
  Operations: register app A, flush, register app B while a flush holds the lock, read B's ingest row.
  Then the live timeline from backlog 84 against the candidates it lists (stale lock after restart,
  a flush that applied remotely and failed locally, a response without the source).
- **Scope.** (1) One info line per sync with revision and outcome (`applied` / `unchanged` /
  `coalesced` / `failed`) and the short reason on failure. (2) A `coalesced` change is not dropped: the
  lock holder's loop already re-reads `desired`; if the reproduction shows a window it misses, close
  it (re-schedule on `coalesced` rather than rely on the 5-minute replay). (3) The deploy writes a run-log
  line when it skips the Operations values for want of an active ingest config, naming the catalog
  state. (4) Decide, with the reproduction in hand, whether a first deploy should wait a bounded time
  for a pending projection; record the decision here. (5) Close backlog 84 with the cause.
- **Acceptance / witness.** The reproduction test passes (B's ingest config is active before its first
  deploy reads it, or the deploy log names the gap). A control test asserts the sync log line per
  outcome. On the live account: register a new app and deploy within ten seconds — the app's service
  carries all four Operations keys, or the run log says why not.
- **Touch points.** `packages/control/src/operations-catalog.ts`, `packages/control/src/run-lifecycle.ts`,
  `packages/control/src/db.ts` (only if the window needs a state change), `packages/control/src/__tests__/`,
  `docs/backlog/84-*.md`.

### WU3 — Roll an installation forward with one command (effort M)

- **Problem.** Every release the rebuild needed meant editing `fabrika.ref` in the sidecar checkout,
  committing, pushing, finding the workflow run and watching it for twenty minutes while five services
  built one after another. The command line knows the sidecar (it created it) and the order invariant
  lives in `deploy.ts`, not in the operator's head.
- **Verify first.** Read `deploy.ts`'s header and ADR-0027 for the ordering property and name exactly
  which pairs are ordered: every write before every deploy; proxy before control. State whether
  `iam`, `operations` and `source` have an ordering reason of their own (the proxy verifies against
  IAM, but it is deployed after IAM either way). Measure the rebuild's five builds: the critical path
  if the first three run concurrently.
- **Scope.** (1) `fabrika platform upgrade --to=vX.Y.Z [--sidecar=<path>|<owner/repo>]`: verifies the
  tag exists on the public repository, writes `fabrika.ref`, commits with a fixed message, pushes, and
  follows the workflow run to its conclusion with the same `gh` the `init` verb already requires —
  printing the run URL first so an operator who leaves can come back. A published tag stays the only
  acceptable ref (ADR-0025); the verb refuses a branch or a SHA. (2) If Verify first finds no ordering
  reason among the first three, `platform deploy` builds `iam`, `operations` and `source` concurrently
  and keeps `proxy` then `control` strictly after — with the order and its reason stated in one
  comment and one test that fails if the sequence changes. (3) The `upgrade` verb is added to the
  installation contract's verb union; the Cloudflare installation refuses it with its existing
  explicit throw.
- **Acceptance / witness.** A test drives `upgrade` against a temporary git repository and a fake
  `gh`: ref written, commit message fixed, refusal on a branch. Live: `fabrika platform upgrade
  --to=<next tag>` from this machine rolls the test installation and returns green; the roll's wall
  clock is recorded in the run log beside the rebuild's 20 minutes.
- **Touch points.** `packages/installation-zerops/src/{upgrade.ts,upgrade-options.ts,deploy.ts,index.ts}`,
  `packages/installation-contract/src/index.ts`, `packages/installation-cloudflare/src/installation.ts`,
  `packages/cli/src/index.ts`, the sidecar workflow template in `packages/installation-zerops/src/templates/`
  if the run needs a dispatch input, CLAUDE.md files of the packages touched, `docs/reference/` where
  the operator's roll procedure is described.

### WU4 — `platform install` can create the project it installs into (effort S)

- **Problem.** The rebuild created its project through a raw `CreateProject` call because `zops project
  create` cannot set what the import needs and `install` only reads a project it is given. The first
  command an operator runs is therefore not a fabrika command.
- **Verify first.** Confirm with the live account that the operator's personal token creates a project
  (`POST /client/{clientId}/project` with `{ name, mode: 'LIGHT', envIsolation: 'service' }` or the
  documented import path); confirm the response carries the id `install` needs; confirm whether the
  project is usable immediately or reports `CREATING` for a while (the rebuild's namespace provisioning
  already polls for that).
- **Scope.** `fabrika platform install --create-project --client-id=<id> [--project-name=<name>]` as an
  alternative to `--project-id`: creates the project, waits for it to be `ACTIVE`, then continues
  exactly as today; refuses when both flags are given, and prints the created project id before the
  first import so an interrupted run can be resumed with `--project-id`. Reuse the namespace
  provisioner's project-creation and polling code rather than a second copy.
- **Acceptance / witness.** A test drives `install --create-project` against the emulator and asserts
  the order: create → poll → import. Live: one `install --yes --create-project` from an empty client
  reaches `install exit 0` with five services `ACTIVE`; `zops` shows the project `LIGHT` and its
  services `envIsolation: service`.
- **Touch points.** `packages/installation-zerops/src/{install.ts,install-options.ts}` and tests,
  `packages/provider-zerops/src/namespace.ts` (extract the create-and-wait step if it is not already a
  function), `packages/installation-zerops/CLAUDE.md`, `docs/reference/` install procedure.

### WU5 — A proxy target registers with the domain its deploy needs (effort S) · backlog [`83`](../backlog/83-a-proxy-target-registers-without-the-domain-its-deploy-needs.md)

- **Problem.** As backlog 83 states: registration accepts a `target.proxy` manifest with no `domain`,
  creates the service, and the first deploy fails in a second; nothing names the hosts a
  `zerops-subdomain` namespace can serve, so the operator reads a `zeropsSubdomain` variable by hand.
- **Verify first.** Which hosts the namespace proxy publishes (one per listening port, from its
  `zeropsSubdomain` variable per `docs/reference/zerops-platform.md`), and whether the proxy service
  record exposes them without the env reading.
- **Scope.** (1) `register` and `apps environments put` answer 400 naming `--domain` when the manifest
  has a proxy target and the environment no domain, before any provider call. (2) `namespaces get` and
  the console detail list the hosts a ready `zerops-subdomain` namespace serves, with the ones already
  taken by an app marked. (3) The CLI help for `register` says when `--domain` is required.
- **Acceptance / witness.** Control test: proxy-target manifest without a domain → 400, provider's
  `prepareRegistration` not called. Provider test: the presentation lists the hosts and marks the
  taken one. Live: `namespaces get apps-test2` prints the 8080 and 8082 hosts as taken and the rest
  free; a registration without `--domain` is refused with the flag's name.
- **Touch points.** `packages/control/src/api/registry.ts`, `packages/provider-zerops/src/namespace.ts`,
  `packages/cli/src/control.ts`, `packages/dashboard/src/routes/namespaces/detail.tsx`,
  `docs/reference/deployment-namespaces.md`; delete backlog 83 on close.

### WU6 — The command line prints what the next command needs (effort S)

- **Problem.** Three places where the operator had to know something the tool knew better: `control
  key issue` needs IAM's PUBLIC origin while its help says "IAM's own origin"; `platform admin` and
  `init` end without saying how to mint the first machine key; `--core-package` help describes the
  sizing ADR-0038 retired.
- **Verify first.** Where the installation already holds the IAM public origin, the IAM RPC key and the
  provisioning key (the `init` Environment and the service env) — and which of them `platform admin`
  can print without printing a secret value.
- **Scope.** (1) `platform admin` and `init` end with a "next: mint a machine key" block: the exact
  `FABRIKA_IAM_RPC_URL` value and the NAMES of the two key variables with where each lives — never a
  value. (2) `control key issue` help and error text name the public origin and, on "Unable to
  connect", say that an internal hostname cannot be reached from outside the project. (3) The
  `--core-package` line describes the ADR-0038 default. (4) One pass over `fabrika control --help` and
  `fabrika platform --help` for any other sentence the rebuild proved wrong.
- **Acceptance / witness.** Snapshot tests of the printed blocks (values redacted by construction —
  the test asserts no `px_` or `rpc_` prefix appears). Live: a fresh shell with only the printed block
  pasted, plus the two keys from the named places, mints a key on the first try.
- **Touch points.** `packages/cli/src/control.ts`, `packages/installation-zerops/src/{admin.ts,init.ts}`
  and tests, `packages/installation-init/src/` if the block is shared, the CLAUDE.md of each.

### WU7 — Release and run-log hygiene (effort S)

- **Problem.** Three small things that cost attention on every release: the registry smoke fails on
  npm's replication lag and needs a manual re-run; the build-log relay mixes lines from earlier app
  versions into a run's log; the public example pins a version eighteen releases old and deploys only
  after a hand edit.
- **Verify first.** How long npm took on the two releases (the `time` field showed ~5 minutes after
  `published`); whether the Zerops log endpoint accepts an app-version filter (the reference doc's log
  section) or the relay must filter client-side by the version's `build.startDate`; whether the
  example repository's pin can be validated from this repository's release job without a cross-repo
  token (a read is enough to warn).
- **Scope.** (1) `release:registry-smoke` polls with backoff for up to ten minutes and prints the
  packages still missing between attempts. (2) The relay drops lines older than the app version's
  pipeline start, or filters by version when the endpoint allows it; a stale line never appears in a
  run log again. (3) `release:example-pin`: a script that, given a checkout path of the example
  repository, rewrites every `@fabrika/*` pin to the released version and prints the diff — run by the
  operator after a release, not by CI (no cross-repo credential in this repository). The release job
  WARNS when the public example's `main` pins a version older than the one just published.
- **Acceptance / witness.** Release script tests cover the backoff and the warning. A provider test
  feeds the relay lines from two app versions and asserts only the current one's are logged. The
  next release needs no re-run, and its run log shows the warning or its absence.
- **Touch points.** `scripts/release.ts` and its tests, `packages/provider-zerops/src/{provider.ts,api.ts}`
  and tests, `docs/reference/` release notes.

### WU8 — Read the `source` service's memory during a real upload (effort S)

- **Problem.** The streamed tarball path (ADR-0037) was built to stop `source` from needing RAM in
  proportion to the repository, and the rebuild proved it deploys at a 0.125 GB floor — but nobody
  read its memory while it worked. The claim that motivated the rewrite is still an inference.
- **Verify first.** What the account exposes: a metrics endpoint on the public API, the console's
  graphs, or nothing but `zops scale get`. If the API has one, it belongs in WU1's live suite as a
  slow case.
- **Scope.** Deploy a repository of a few hundred megabytes (a throwaway with generated files) through
  the test installation and record `source`'s peak memory and container count during the upload, and
  the same for a small repository. Write both into `docs/reference/zerops-platform.md` beside the
  ADR-0037 description. No code unless the reading contradicts the design — then a backlog item.
- **Acceptance / witness.** Two numbers in the reference doc with the date, the repository sizes and
  how they were read; `source` did not scale past its floor for either.
- **Touch points.** `docs/reference/zerops-platform.md`; the throwaway repository lives outside this
  repository.

## Out of scope (explicit)

- **Readiness probing of control through the proxy** — `/healthz` is already public
  (`packages/control/fabrika.gates.ts:29`); the rebuild polled the wrong path.
- **Pinning a sidecar to a branch or SHA** for test installations — ADR-0025 pins tags on purpose
  ("which version is this installation running" must be answerable); a throwaway paying a release per
  hotfix is the accepted price. WU3 makes the roll cheap instead.
- **Parallelising `proxy` and `control`** — the order carries the ADR-0022 security property
  (enforcement point before the service whose gates widened). Only the first three are candidates.
- Backlog [`75`](../backlog/75-a-running-installation-keeps-a-token-that-cannot-create-projects.md)
  (re-minting control's token), [`80`](../backlog/80-harmonize-the-admin-rpc-principal-inputs.md),
  [`82`](../backlog/82-a-duplicate-cross-app-grant-answers-500.md) — real, unrelated to bring-up
  friction, not this theme.
- Cleaning up the throwaway account state (`fabrika-test2`, `apps-test2`, the second organization's
  test repository, old GitHub Apps and tokens) — the operator's call, and WU3/WU4/WU8 still need the
  installation.

## Decisions

1. **One fact table, two consumers.** A platform fact is "verified" when the live suite asserts it
   and the emulator test asserts the same row. Hand-written "Verified live" sections stay as the
   narrative; the table is the contract. (WU1)
2. **Tags stay the only sidecar ref.** `upgrade` automates the roll; it does not widen what a roll
   may point at. (WU3, ADR-0025)
3. **No cross-repository credential in CI.** The example's pin is validated by a read and fixed by an
   operator-run script, not by a bot with write access to another repository. (WU7)
4. **Secrets are never printed to help the next command** — the "next step" blocks print origins and
   variable NAMES only. (WU6)

## Sequencing

| Wave | Units                               | Why together                                                                                                                                                                                          |
| ---- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | WU1 Verify first · WU3 Verify first | The fact list and the ordering question shape two units' scope; settle both before slicing.                                                                                                           |
| 1    | WU1 · WU2 · WU5 · WU7               | Disjoint territories: local-stack + provider tests · control catalog · control registry + namespace presentation · release script + relay.                                                            |
| 2    | WU3 · WU4 · WU6                     | All touch `installation-zerops`; WU3 and WU4 share `index.ts` and the CLAUDE.md — one agent, or region rules. WU6's `cli/control.ts` edit is separate from WU5's `register` help line only by region. |
| 3    | WU8                                 | Needs the installation rolled to the WU1–WU7 release (`upgrade` from WU3 is its first live use).                                                                                                      |

Gate per unit as in the last sprint: typecheck and the unit's tests by the implementer, the full
`bun test` with PostgreSQL, lint, format and `release:validate` by the leader before each commit; the
live witnesses of WU3, WU4, WU5 and WU8 against the test installation, recorded in the run log with
identifiers redacted where they are credentials.

## Run log

<!-- Append as you work: discoveries, deviations, blockers. Graduate each entry:
     changed the *why* → ../decisions/NNNN ; new future work → ../backlog/NN ;
     transient → leave it (dies with the sprint on archive). After graduating,
     trim to a one-line pointer ("→ ADR-0007"). -->

- 2026-08-21 — Wave 0 (read-only). WU3: no ordering reason exists among `iam`, `operations`, `source` —
  none reads a sibling at boot (`iam` holds no sibling origin; `operations` constructs `HttpIamRpc`
  without a request; `source` only imports a key), readiness checks hit each service's own `/healthz`,
  and the deploy's write set is per service (`deploy.ts:239-294`); `source → proxy` in
  `deploy-order.test.ts:44` has no stated reason but stays true by construction. The two rebuild rolls
  measured **9 min 36 s and 9 min 32 s** for the five builds (iam 113 s · operations 113–123 s · source
  113 s · proxy 93 s · control 134–139 s), not the 20 minutes this plan and `templates/platform.yml:48`
  claim; the concurrent critical path is ~5 min 50 s. Nothing in `init` persists the sidecar location,
  so `upgrade` takes `--sidecar`. WU1: 33 facts a client depends on; 6 probeable with a token alone,
  16 with one imported service, 8 need a build, 3 are not probeable without account-level side effects.
  The table lives in `packages/provider-zerops/src/__tests__/platform-facts.ts` (private-package tests
  may import a public package's test helpers by relative path; the reverse direction is refused by
  `release:validate`, and a root `tests/` directory is typechecked by nothing).
- 2026-08-21 — Leader probes against the account (throwaway projects, created and deleted). WU4:
  `POST /client/{id}/project/import` with a `project:` block and `services: []` creates an empty project
  in ~1 s; it reads `mode: LIGHT` at once and `status` `NEW → CREATING → ACTIVE` in ~20 s. WU5: the
  proxy's hosts are the SYSTEM env `zeropsSubdomain`, one URL per listening port, also present in the
  service record's `userData`. WU7: the log service's `urlInfo` lists tags; `tags=zbuilder@<appVersionId>`
  (without `serviceStackId`) selects one version's build log; runtime lines carry no version marker;
  `from=` and unknown parameters are ignored silently; `format` accepts `rfc_3164|rfc_5424|raw`. WU1:
  `DELETE /service-stack/{id}` answers 200 with a `stack.delete` process (FINISHED in ~21 s), after which
  by-id, by-name and a second DELETE answer `400 serviceStackNotFound`; a successful user-data POST
  answers 200 (the emulator said 201); user-data on an absent service is `400 serviceStackNotFound`
  (the emulator said 404).
