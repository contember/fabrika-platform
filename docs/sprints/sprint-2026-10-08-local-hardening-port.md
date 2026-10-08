# Sprint — Port local-hardening onto main (2026-10-08)

**Goal.** Land the nine backlog fixes of the unmerged `sprint/local-hardening` branch on current `main`.

**Theme.** The branch (base `4bb81292`, closed 2026-09-28) conflicts in 63 files with `main`, which moved 154
commits since. Each of its work units is redone on `main`, with the old commit as a guide. This is step 2 of G0 in
the [orchestration](../ideas/app-framework-orchestration.md); step 1, `mcp-authoring`, landed at `28706106` after the
full gate (typecheck, lint, format, 4070 + 317 + 180 tests pass, 0 fail, 38 skip for live Zerops only, with Postgres
and S3 set).

Old sprint: `git show sprint/local-hardening:docs/archive/sprint-2026-09-28-local-hardening.md`.

## Refs re-verified at HEAD (2026-10-08)

- ✔ Backlog 57, 78, 79, 80, 81, 82, 84 are still open on `main` — `docs/backlog/`.
- ⚠ `packages/iam-ui` is folded into `packages/dashboard`; `installation-zerops` into
  `provider-zerops/src/installation` and `platform-artifacts`; `control/src/node` into `control/src/zerops`;
  `source-zerops` is deleted (Control streams GitHub sources in-process).
- ⚠ Migrations are squashed to `0001_init.sql`; MCP authoring added `0002_*` in control and iam. P4 owns control
  `0003`.

## Work units

### P1 — One principal key and an idempotent grant (S; backlog 80, 82) — old commit `3eac6adf`

- Lane: IAM. Yours: `packages/iam-contract`, `packages/iam`, and the callers of the changed inputs (dashboard,
  `installation-init`, `platform-artifacts`, provider installations) — callers only, the minimum change.
- Scope: every admin-RPC procedure that names a principal takes `principalId`; change `PrincipalIdInput` and move
  every caller in the same change. A duplicate cross-app grant answers 409, not 500.
- Witness: one test asserts the key across the whole contract; an IAM test creates the same grant twice → 409; the
  admin contract test asserts the new status.

### P2 — IAM chooses its own correlation id (S; backlog 57) — old commit `4179dbe6`

- Lane: IAM (starts after P1 is on main). Yours: `packages/iam`.
- Scope: the composition root names the trusted correlation header (pattern of `client-address.ts`). Cloudflare
  trusts `cf-ray`, never `X-Request-Id`. Node trusts the header the proxy overwrites. Length cap + character
  allowlist; anything else is replaced by a generated id. Check control and operations for the same pattern and
  report; do not change them. Backlog 92 (filed by the old sprint, not on main): re-file it only if it still holds
  at HEAD.
- Witness: tests on both compositions.

### P3 — A dead flush holder does not block the catalog (S; backlog 84) — old commits `6312e80c`, `bf9a9cf4`

- Lane: Control-ops. Yours: `packages/control/src/operations-catalog.ts`, the Zerops composition root's shutdown
  handling (`packages/control/src/zerops/`), their tests.
- Decision: release the lease on SIGTERM; shorten the catalog lock TTL to the upper bound of one flush (verify the
  bound first). No change to the `deploy_locks` port.
- Witness: the replay after a dead holder delivers within the new TTL; SIGTERM during a flush releases the lease.

### P4 — The Cloudflare runner hand-off survives a self-deploy (M; backlog 88, 89) — old commits `04d01cdc`, `cc22f19a`

- Lane: Runner. Yours: `packages/runner-cloudflare`, `packages/runner-container` if needed, the runs table code in
  `packages/control/src/db/`, `packages/control/src/{platform-cf.ts,run-lifecycle.ts}` (minimal), the
  `provider-cloudflare` control side, **new migration `0003_run_iam_reconcile.sql` in both
  `packages/control/migrations/` and `migrations-postgres/`** (this number is reserved for you).
- First check backlog 88 and 89 at HEAD: the simplification sprints changed runner outcomes ("settle runner
  outcomes only through Control", "drop the runner source-protocol handshake"). If 88 no longer applies, say so with
  evidence and do only what still holds.
- Decisions: 88 — persist the reconcile on the run, apply at least once from the RPC return and the maintenance
  sweep, mark applied. 89 — the user chose a keyed container instance name plus an instance check in the backstop
  methods (option b; see the old run log); keep the residual in backlog 89.
- Witness: a run that finished with a reconcile while no `deploy` awaits it is reconciled by the next sweep, once;
  a backstop call for a foreign instance is refused before container work.
- The old sprint filed backlog 93 and 94; re-file only if they still hold at HEAD.

### P5 — A namespace's profile can change (M; backlog 79) — old commit `aa1c63de`

- Lane: Namespaces (starts after P3 and P4 are on main — shared Control files). Yours: `packages/control-contract`,
  `packages/control/src/{api/namespaces.ts,control-rpc.ts,db/registry*.ts}`, `packages/provider-contract`,
  `packages/provider-zerops/src/namespace/` and `api/`, the Zerops emulator in `packages/local-stack`, the dashboard
  namespace pages.
- Decision: profile mutable, type immutable; `namespaces.update` changes the profile through the Zerops autoscaling
  endpoint (Zerops ignores a changed profile on re-import); a type change is refused naming the supported path. No
  new state value (old run log: the `failed` marker approach).
- Witness: through the public RPC alone a default namespace moves to `oltp-production` against the fake Zerops API;
  a type change is refused.

### P6 — Register a Zerops app in one command (S–M; backlog 78) — old commit `2c0e6940`

- Lane: CLI. Yours: `packages/cli`, `packages/provider-zerops/src/cli.ts`, CLI usage docs.
- Scope as backlog 78: reuse the provider compiler and the existing Control registration request; no new Control
  endpoint and no intermediate file. If MCP authoring or the simplification changed registration, adapt.
- Witness: byte-for-byte request equality with registering the same manifest from disk.

### P7 — A private keyed deploy in the local stack (M; backlog 81) — old commit `817669d3`

- Lane: Local stack (starts after P6 is on main). Yours: `packages/local-stack`, a composition-only seam in Control's
  GitHub source runtime (`packages/control/src/github/`, minimal), `docs/reference/local-development.md`.
- The old design put the seam in `source-zerops`, which is gone. Find the equivalent seam in Control's in-process
  GitHub client. Production origins must stay unmovable by environment variables (keep or add the test that says
  so). If no composition-only seam exists without changing the module boundary, stop and report.
- The old commit also fixed `local:smoke` being broken; check whether it still is (read the code, do not run the
  stack) and say what you found.
- Witness: unit and integration tests of the double and the seam. The integrator runs `bun run local:smoke`.

## Out of scope (explicit)

- Part 0, A and B of the [implementation plan](../ideas/app-framework-implementation-plan.md); they start after
  this sprint closes.
- A CLI verb for `namespaces.update`.

## Decisions

The old sprint's decisions stand (80 → `principalId`; 89 → keyed instance name plus an instance check; 84 → SIGTERM
release plus a shorter TTL; 79 → profile mutable, type immutable; 81 → a GitHub API double).

## Sequencing

Wave 1, in parallel: P1 (IAM), P3 (Control catalog), P4 (runner and runs), P6 (CLI). Wave 2: P2 after P1; P5 after
P3 and P4; P7 after P6. Each work unit: implementer in its own worktree → independent review → fix round →
integrator gate → fast-forward to `main`.

## Run log

- 2026-10-08: `mcp-authoring` landed on `main` (`28706106`). Wave 1 started from it. Spikes S-A7 (parser) and S-A8
  (Kysely on `Bun.SQL`) run in scratch, outside the repository.
- 2026-10-08: P4 landed (`64db75aa`, `3b6afbd7`). Backlog 88 was already closed on `main` by `b2935a15` (Control
  settles Cloudflare runs and applies their IAM reconcile from R2); no migration was needed, `0003` stays free. 89:
  keyed instance name plus an instance check on four `RunnerContainer` methods; residual re-filed. Old 93 no longer
  holds; 94 re-filed.
- 2026-10-08: P6 landed (`8bf351fe`, `c49f048f`) after one review round: compile errors drop the Control key; a
  config that fails during provider inference reports the compile phase. Found, not fixed: `app build`, `app deploy`
  and `control register` echo raw exceptions.
- 2026-10-08: P3 and P1 went through one fix round each. P3 does not shorten the catalog TTL: `main` already uses
  ADR-0044's renewed 90 s lease. P1 decides a duplicate grant from `INSERT … ON CONFLICT <index> DO NOTHING`, not
  from driver error codes.
- 2026-10-08: Owner checkpoints answered: parser `@babel/parser` 8.0.7 (H4), `kysely-postgres-js` 5.0.1 over
  `Bun.SQL` (H5), A8 split into A8a and A8b (H3) — recorded in the implementation plan.
