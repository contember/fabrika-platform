# Release watch window and rollback

**Summary.** For a fixed window after a run succeeds, Operations scores the release from the evidence it already
holds: new issues, regressions, spikes and failed health checks. A bad score marks the run `suspect` and fires one alert
that names a rollback target and whether rolling back is safe. Control decides safety from the two runs' approved
snapshots: no migration and no access widening between them. An environment may opt in to an automatic rollback on a
safe verdict.

**Size.** M overall: six PRs, three M and three S (one of them docs).

**Depends on.** Nothing hard. It reuses the approval diff that
[the access diff check](./access-diff-as-a-github-check.md) also reuses.

**Enables.** The [fleet overview](./fleet-overview.md) (each environment's last verdict),
[operations tools in the authoring MCP](./operations-tools-in-the-authoring-mcp.md) (an agent reads the verdict), and
backlog [270, the self-healing loop](../backlog/270-a-self-healing-loop.md), whose trigger is a suspect run. Backlog
[268, opice journeys](../backlog/268-opice-journeys-as-a-stage-gate-and-production-checks.md) would add a health signal
to the score.

## Problem

- After a deploy nobody watches whether it brought errors. Operations counts new issues and regressions per release
  (`packages/operations/src/repositories/operator.ts:495-508`, `newIssueCount`/`regressionCount` on
  `OperationsReleaseSummaryDto`), but only as numbers on a page. No alert speaks about a release.
- A rollback is a new deploy of an older commit ([ADR-0050](../decisions/0050-approved-access.md) §6). Control has no
  verb for it. `triggerDeploy` takes a ref and no commit (`packages/control-contract/src/index.ts:637`). The only
  redeploy of an earlier run is inside a side restore (`redeployable`, `packages/control/src/data-operations.ts:433`).
- An operator who wants to roll back must work out alone whether a migration ran in between and whether the older
  version would widen access again. Only fabrika holds both the migration list (in each run's snapshot) and the error
  stream; a standalone error tracker cannot answer it.

## Design

### What exists (confirmed at `e06eac287`)

- Control projects every run to Operations (`projectOperationsRun`, `packages/control/src/operations-releases.ts:45`).
  Operations keeps one `releases` row per source and commit (`UNIQUE (source_id, commit_sha)`,
  `packages/operations/migrations/0001_init.sql:192`); a later run of the same commit takes the row over
  (`packages/operations/src/repositories/artifacts.ts:45-49`). `deploy_run_links` keeps one row per run
  (`0001_init.sql:207`).
- Occurrences carry the release name (`occurrences.release`); an issue records `first_seen` and `regressed_at`
  (`0001_init.sql:56-93`). `decideOccurrenceTransition` marks a regression against `resolved_in_release`
  (`packages/operations/src/issues.ts:8`).
- Alerts: rules per source and type, channels per source and scope, an outbox with a dedup key
  (`packages/operations/src/alerts.ts:35-121`). Spikes are per fingerprint per minute against a threshold
  (`alerts.ts:84`).
- Health: HTTP checks per source with failure and recovery thresholds, and telemetry health; each transition
  (`failed_check`, `recovery`, `unhealthy_telemetry`) enqueues alerts (`packages/operations/src/health.ts:7-8`,
  `health-service.ts:163`, `:213`).
- Operations maintenance runs every minute (`packages/operations/fabrika.config.ts:39`, `maintenance.ts:48`).
- Each run stores its access snapshot (`runs.snapshot_json`, `packages/control/src/db/runs.ts:35`). A snapshot holds the
  migration files with checksums and the framework release (`packages/control/src/approval/snapshot.ts:18-45`).
  `classifyAccess(baseline, candidate)` answers `none`, `no-widening` or `widening`
  (`packages/control/src/approval/diff.ts:109`). A migration the candidate lacks reads as a narrowing
  (`diff.ts:1721-1723`), so the approval diff of a rollback says nothing about a migration it leaves behind.
- Source checks: on Zerops a run that records a commit and names a branch fails `commit_mismatch` once the branch moved
  on; an exact commit as the ref passes (`packages/control/src/github/source/repository.ts:89-91`,
  [ADR-0048](../decisions/0048-bind-cloudflare-delivery-to-the-recorded-commit.md)). On Cloudflare a manual run pinned
  to a commit deploys that commit (`packages/control/src/platform-cf.ts:276-283`).

### The watch window (Operations)

A window opens when Operations receives a run's terminal projection with outcome `succeeded`, for each source of that
run. It lasts `windowMinutes` (default 15). Maintenance evaluates open windows each minute and closes each with a
verdict. Evidence is keyed by run and time, not by release name alone: a rollback redeploys a commit whose release row
and name already exist, so only occurrences received inside this run's window count.

Evidence per (run, source), all inside the window:

- **New issues**: issues whose first occurrence carries this release, level `error` or `fatal`. One counts when it has
  at least `minOccurrences` occurrences in the window (default 3). Fewer is listed as evidence below threshold.
- **Regressions**: occurrences of this release with `transition_kind = 'regressed'`. One is enough: a resolved issue
  came back.
- **Spikes**: a spike claim on a fingerprint whose window occurrences carry this release.
- **Health**: an HTTP check of the source that went `failed` and did not recover before the window closed, or an
  `unhealthy_telemetry` transition.

Verdicts: `suspect` (any counted evidence), `clean` (none, and at least one health check of the source succeeded in the
window), `quiet` (none, and nothing proves the release served: no health check). A newer run's window opening for the
same source closes the older one as `superseded`. Low traffic is handled by the occurrence threshold and by `quiet`:
silence is never reported as health.

Thresholds and the window length are per environment, stored beside the existing alert config. Defaults live in code.

The scoring is a pure function over an evidence record, so its table of cases is a unit test.

### The alert

A new alert rule type and channel scope, `suspect_release`, dedup key `suspect:<source>:<run>`. It fires once, when a
window closes `suspect`. The payload keeps today's `text` shape (`alerts.ts:127`) and adds `runId`, `releaseName`,
`commitSha`, the evidence counts with up to five issue titles and fingerprints, and `rollback` as Control projected it
(below). An environment without a `suspect_release` rule gets no alert; the verdict still shows in the console.

### The rollback verdict (Control)

Control computes it when a run succeeds and projects it with that run's terminal projection, so Operations can put it
in the alert without calling Control. The current run is `S`; the target `T` is the environment's previous succeeded
run without a lane (`runs.lane IS NULL`), the run `getLatestSucceededRun` answered before `S` (`db/runs.ts:144`).

`rollbackVerdict(S, T)` is pure over the two stored snapshots and the environment row:

| Check                                                                       | Fails as             |
| --------------------------------------------------------------------------- | -------------------- |
| `T` exists and has a commit and a stored snapshot                           | `no_target`          |
| `T.framework` is inside the platform's reader window (ADR-0062)             | `outside_window`     |
| No migration file in `S` that `T` lacks, and no file whose checksum differs | `migrated` + names   |
| `classifyAccess(S, T)` is not `widening`                                    | `widens` + its lines |
| The environment is `standard` or `prod`, not `dev`                          | `not_rollbackable`   |

All pass: `safe`. The verdict names `T`'s run id and commit, and the migration names or the widening lines when it
fails. It is advice computed at `S`'s success; the rollback itself checks again (below).

### The rollback (Control)

A new use case, `runs.rollback { appId, env, targetRunId, expectedCurrentRunId }`:

1. Authorize `deploy.trigger` at the coordinates; a denial is the 404 of an absent environment, as for every run use
   case.
2. Under the environment's lease: refuse with 409 when the latest succeeded run is not `expectedCurrentRunId`, when a
   run is pending or running, or when the recorded maintenance mode is not `open`.
3. Create a manual run with the target's commit as both `ref` and `commitSha` (`createManualRun`,
   `packages/control/src/api/runs.ts:206`), so both providers' source checks pass, and record `runs.rollback_of = S`.
4. The run then goes through the ordinary pipeline: it re-reads the commit's snapshot, classifies it against the
   active snapshot and parks on a widening of a protected environment (ADR-0050 §6). The IAM schema, workload keys and
   the Cloudflare object pointer follow as for any deploy.

Per provider, a rollback is a full deploy: on Cloudflare the runner clones, builds and runs `wrangler deploy`; on Zerops
Control uploads the source and the platform builds it. Neither uses the cloud's own version rollback (Workers versions,
a Zerops archived app version): both would skip Control's run row, the IAM schema write and the approval. A rollback
takes as long as a deploy.

The branch still points at `S`. The next push deploys forward, which is the intended exit from a rollback. The
environment page says so while a rollback run is the latest succeeded run.

### Automatic rollback (opt-in)

An environment flag `auto_rollback`, off by default. Control's maintenance pass asks Operations for windows closed
`suspect` since its cursor (a private endpoint under the release sync key, beside `/private/releases/reconcile`). For
each one on an environment with the flag, it computes the verdict again at that moment and starts `runs.rollback` only
when the verdict is `safe` and `S` is still the latest succeeded run. The run's actor is Control's maintenance. Guards:

- never roll back a run that itself has `rollback_of`;
- at most one automatic rollback per environment until a person deploys again;
- a rollback that would park is never started automatically: only a person approves (ADR-0050 invariant).

A verdict other than `safe` leaves the alert as the only action.

## API and contract changes

- **Operations migration** (one new file per dialect in its bundle, ADR-0017): `release_windows` (run, source, opened,
  closes, verdict, evidence JSON, closed), `release_watch_config` (source, window minutes, min occurrences).
- **Operations operator RPC**: `releases`/`release` gain `verdict` and `evidence`; `releaseWatchConfig` get/put under
  `operations.manage`. Console: the release page shows the verdict and its evidence; the alert settings list
  `suspect_release`.
- **Control ↔ Operations**: the terminal release projection gains an optional `rollback` field. The request header
  schema strips unknown keys (`packages/operations-contract/src/release-schemas.ts:64`, `z.object`), so an older
  Operations ignores it. A new private `POST /private/releases/suspects` answers closed suspect windows after a cursor;
  Control treats its 404 as "none".
- **Control migration**: `runs.rollback_of TEXT NULL`; `app_envs.auto_rollback INTEGER NOT NULL DEFAULT 0` (or a row
  table like `app_env_backup_schedules`; decided in PR 4).
- **Control RPC**: `runs.rollback`, `RunDto.rollbackOf`, `RunDto.rollbackVerdict` for the latest succeeded run,
  `apps.environments.setAutoRollback`.
- **Application ↔ platform protocol (ADR-0062)**: unchanged. The release name, the DSN, the ingest shape and the
  `FABRIKA_*` variables stay as they are; an application on any framework release in the window is scored the same.

## Security and permissions

- `runs.rollback` is authorization in Control (`.require` plus the scoped check of `deploy.trigger`), not an
  enforcement decision; the console's session reaches it through the proxy's existing admission. It grants nothing
  `triggerDeploy` does not: a person who may deploy may deploy an older commit.
- A rollback that restores removed access parks for approval like any widening, and only a human approves
  (`packages/control/src/approval/human.ts`). Automatic rollback never starts one that would park.
- `auto_rollback` lets Control deploy without a person. Setting it takes the same human rule as
  `apps.environments.protect`: a `user` principal with no OAuth or link claims and no bearer. A builder key or an MCP
  token cannot switch it on.
- Audit: the rollback run's `deploy.trigger` audit carries `rollbackOf` and the verdict; an automatic one names
  Control's maintenance as the actor. IAM's audit delivery is best-effort today (backlog
  [71](../backlog/71-deliver-domain-audit-events-durably.md)); the run row is the durable record.
- A rollback that narrows access depends on the IAM write after publish; while that write fails, the narrowing is not in
  force (backlog [226](../backlog/226-a-failed-iam-reconcile-leaves-a-narrowing-unapplied.md)). The rollback adds no new
  window; it inherits that one.
- The alert payload carries issue titles, as today's new-issue alert does. It carries no event payload.

## Rollout on an existing installation

1. **Generated files.** None change.
2. **Environment variables.** None added. Defaults are code constants; settings are rows.
3. **Provider state.** Unchanged. Existing runs have no `rollback_of` and read as ordinary runs. Their stored
   snapshots are what the verdict reads; a run whose snapshot predates the `framework` field reads as
   `outside_window` unless its reader can be inferred, so the first verdict after the upgrade may say so once.
4. **Floating pins.** None.

Both migrations are additive and run on `fabrika platform upgrade` with each service's own ledger. During a rolling
upgrade an older Operations ignores the `rollback` field and answers 404 on `suspects`; an older Control sends neither.

## Test plan

- **Scoring** (Operations, pure): one new issue below threshold → `quiet`/`clean` with evidence listed; at threshold →
  `suspect`; one regression → `suspect`; a failed check that recovers inside the window → not counted; one that does
  not → `suspect`; no health check → `quiet`; a newer run → `superseded`.
- **Evidence query** (Operations repository, SQLite and Postgres; Postgres skips without `FABRIKA_TEST_POSTGRES_URL`):
  a rollback run of an earlier commit counts only occurrences inside its own window, though it shares the release row.
- **Alert**: one `suspect_release` notification per source and run across repeated maintenance passes; payload shape.
- **Verdict** (Control, pure): migration added → `migrated` with names; checksum change → `migrated`; widening →
  `widens` with lines; framework outside the window → `outside_window`; `dev` → `not_rollbackable`; else `safe`.
- **Use case**: the run's ref and commit are the target's commit; `rollback_of` recorded; stale `expectedCurrentRunId`
  → 409; denied → 404; a busy or restricted environment → 409. On the Zerops source path, a rollback run passes where a
  manual run of the branch pinned to the older commit fails `commit_mismatch` (a witness of today's behaviour).
- **Automatic rollback** (Control maintenance with a fake Operations): opted in and safe → one run; a second pass → no
  second run; `widens` or `migrated` → no run; a newer deploy meanwhile → no run; `suspects` answering 404 → no error.
- **Older code on a newer schema**: a witness that a release whose files are a subset of the ledger boots on both
  providers (see open question 2).

## Slicing into PRs

1. **Operations: watch windows and verdicts** (M). Migration, scoring, maintenance evaluation, verdict on the release
   DTOs and console page. Witness: scoring table and evidence query tests.
2. **Operations: the `suspect_release` alert** (S). Rule type, channel scope, payload, console settings. Witness: alert
   dedup and payload test.
3. **Control: rollback verdict and `runs.rollback`** (M). `rollback_of` migration, pure verdict, projection field, use
   case, console button on the environment page with the verdict lines. Witness: verdict and use case tests, the Zerops
   source witness.
4. **Control: automatic rollback** (M). Flag with the human setter, `suspects` endpoint in Operations, maintenance
   client and guards. Witness: maintenance tests.
5. **MCP and fleet read-outs** (S). Expose the verdict to the console fleet view and the operations MCP tools, after
   those specs land.
6. **Docs** (S). `reference/operations-errors.md` gains the watch window; the ADR below; `ideas/operations-plane.md`
   drops "rollback evidence" and the question "Did the rollback remove the error and restore the health check?", which
   the rollback run's own window now answers.

PRs 1 and 3 are independent; 2 follows 1; 4 follows 2 and 3.

## Open questions

1. **Which target is the default?** The previous succeeded run, or the newest earlier run whose window closed `clean`?
   Default: the previous succeeded run; the console lets a person pick any earlier one.
2. **Does an older release boot on a schema that ran newer migrations?** Not confirmed in code on either provider.
   Default: the verdict stays `migrated` for any migration between, so automatic rollback never relies on it.
3. **Which environments get a window?** Default: every non-`dev` environment with an Operations source; automatic
   rollback only where the flag is on, which suits `prod` most.
4. **Spikes without a release tag.** A spike is per fingerprint, not per release. Default: count it only when its
   window occurrences carry this release.
5. **A faster rollback on Zerops** by re-activating the archived app version instead of building. Its descriptor
   carries `FABRIKA_RELEASE` ([ADR-0044](../decisions/0044-zerops-delivery-ownership-and-recovery.md)), but it skips
   Control's run, IAM schema and approval. Default: no; revisit only if build time hurts.
6. **ADR.** Automatic rollback makes Control deploy without a person. Default: a new ADR, "a suspect release rolls back
   only when nothing migrated or widened between", and a one-line pointer from ADR-0050 §6.
