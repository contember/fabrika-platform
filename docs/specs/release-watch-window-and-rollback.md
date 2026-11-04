# Release watch window and rollback

**Summary.** For a fixed window after a run succeeds, Operations scores the release from the evidence it already
holds: new issues, regressions, spikes and failed health checks. A bad score marks the run `suspect` and fires one alert
that names a rollback target and whether rolling back is safe. Control decides safety from the object's applied
migration ledger and the two runs' approved snapshots: no migration applied since the target and no access widening.
A person rolls back from the console. An automatic rollback is not part of this spec: it waits in
[backlog 273](../backlog/273-automatic-rollback-of-a-suspect-release.md) for its own ADR.

**Size.** M overall: five PRs, two M and three S (one of them docs).

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

A window belongs to a run that succeeded, per source of that run. It is anchored to the run's recorded finish time,
which Control carries in the terminal projection as `finishedAt` (`runs.finished_at`), never to the time the projection
arrives: projections sit in Control's outbox and are replayed after an Operations outage
(`packages/control/src/operations-releases.ts:107`, `:217`), so delivery can come late, twice or out of order. The
window is `[finishedAt, finishedAt + windowMinutes]` (default 15). The row is keyed by (run, source), so a replay finds
it and changes nothing. A run whose window already ended when its projection arrives is scored at once: occurrences
and health observations keep their own timestamps. A window is scored one grace period (2 minutes) after it ends, so
late ingest still counts.

Supersession is by recorded finish time too: a run of the same source with a later `finishedAt` (ties by run id, which
is a UUIDv7) closes an older window as `superseded`, whichever projection arrived first. An older run whose projection
arrives after a newer run's opens directly as `superseded`.

Evidence is keyed by run and time, not by release name alone: a rollback redeploys a commit whose release row and name
already exist, so only occurrences received inside this run's window count. Evidence per (run, source):

- **Health** (platform-observed): an HTTP check that Operations itself runs against the source went `failed` and did
  not recover before the window ended.
- **New issues** (ingested): issues whose first occurrence carries this release, level `error` or `fatal`, with at
  least `minOccurrences` occurrences in the window (default 3). Fewer is listed as evidence below threshold.
- **Regressions** (ingested): occurrences of this release with `transition_kind = 'regressed'`. One is enough.
- **Spikes** (ingested): a spike claim on a fingerprint whose window occurrences carry this release.

Ingested evidence is forgeable. Every member SPA is handed the environment's Operations DSN and its current release
(`packages/app/src/client/error-reporting.ts:9-10`, `packages/app/src/__tests__/browser-config.test.ts:29`), and the
server reports through the same public ingest key, so anyone can post events tagged with the current release. The
window therefore keeps two verdicts:

- **Observed verdict**, from platform-observed evidence only: `suspect` when a check failed and stayed failed,
  `clean` when at least one check succeeded in the window and none stayed failed, `unobserved` when the source has no
  check. Only this verdict could ever start an automatic rollback ([backlog 273](../backlog/273-automatic-rollback-of-a-suspect-release.md)).
- **Reported verdict**, from all evidence: `suspect` when any counted evidence exists, else `clean`/`quiet`. It drives
  the alert and the console, labelled "from reported errors", and never starts anything by itself.

Low traffic is handled by the occurrence threshold and by `quiet`/`unobserved`: silence is never reported as health.

Thresholds and the window length are per environment, stored beside the existing alert config. Defaults live in code.

The scoring is a pure function over an evidence record, so its table of cases is a unit test.

### The alert

A new alert rule type and channel scope, `suspect_release`, dedup key `suspect:<source>:<run>`. It fires once, when a
window closes with either verdict `suspect`. It names which verdict and whether the evidence was observed or reported.
The payload keeps today's `text` shape (`alerts.ts:127`) and adds `runId`, `releaseName`,
`commitSha`, the evidence counts with up to five issue titles and fingerprints, and `rollback` as Control projected it
(below). An environment without a `suspect_release` rule gets no alert; the verdict still shows in the console.

### The rollback verdict (Control)

Control computes it when a run succeeds and projects it with that run's terminal projection, so Operations can put it
in the alert without calling Control. The current run is `S`; the target `T` is the environment's previous succeeded
run without a lane (`runs.lane IS NULL`), the run `getLatestSucceededRun` answered before `S` (`db/runs.ts:144`).

**Migration evidence is the applied ledger, not the snapshots.** A snapshot lists only the repository's migration
files (`packages/control/src/approval/read.ts:124`). The object also applies the framework's own bundle before the
application's (`migrationBundles`, `packages/app/src/cloudflare/application.ts:294`), and a run that failed between two
successes can leave a migration applied that neither snapshot records. `pendingMigrations` already prefers the
object's ledger for this reason (`packages/control/src/data-operations.ts:449`). So:

- When a run succeeds on an environment whose release serves the ops channel, Control reads the object's ledger with
  `inspect` (every bundle, name and checksum) and records it on the run (`runs.applied_ledger_json`).
- At verdict time Control reads the ledger again. It is unchanged since `T` recorded its own iff every row now present
  was present in `T`'s record. A failed run's migration shows up here, because it is in the ledger.
- No ledger for `T`, or none now (Zerops, which serves no data operations today; a Cloudflare release without the
  channel; a channel that does not answer): the evidence is `unknown`.

`rollbackVerdict(S, T, ledgerNow)` is pure over the stored snapshots, the two ledgers and the environment row:

| Check                                                                | Fails as                  |
| -------------------------------------------------------------------- | ------------------------- |
| `T` exists and has a commit and a stored snapshot                    | `no_target`               |
| `T.framework` is inside the platform's reader window (ADR-0062)      | `outside_window`          |
| Both ledgers are known                                               | `migrations_unknown`      |
| No ledger row (any bundle) now that `T`'s record lacks, none changed | `migrated` + bundle/names |
| `classifyAccess(S, T)` is not `widening`                             | `widens` + its lines      |
| The environment's kind is `standard`, not `dev`                      | `not_rollbackable`        |

All pass: `safe`. With `migrations_unknown` the console still lists the snapshot difference as a hint, labelled as not
proof. The verdict names `T`'s run id and commit. The kinds are `standard | dev`
(`APP_ENV_KINDS`, `packages/control-contract/src/index.ts:213`); `prod` is an environment name, not a kind. The verdict
projected at `S`'s success is advice for the alert; the rollback computes it again with a fresh ledger.

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

### Automatic rollback (not in this spec)

Decided at review: this spec ships the warning (the window, both verdicts and the `suspect_release` alert) and the
manual rollback above. Control never deploys without a person here. An automatic rollback on the observed verdict, with
its opt-in flag, its guards and its own ADR, is [backlog 273](../backlog/273-automatic-rollback-of-a-suspect-release.md).

## API and contract changes

- **Operations migration** (one new file per dialect in its bundle, ADR-0017): `release_windows` (run, source,
  `finished_at` anchor, ends, observed verdict, reported verdict, evidence JSON, scored), `release_watch_config`
  (source, window minutes, min occurrences).
- **Operations operator RPC**: `releases`/`release` gain both verdicts and the evidence; `releaseWatchConfig` get/put under
  `operations.manage`. Console: the release page shows the verdict and its evidence; the alert settings list
  `suspect_release`.
- **Control ↔ Operations**: the terminal release projection gains optional `finishedAt` and `rollback` fields. A
  projection without `finishedAt` (an older Control) opens no window. The request header
  schema strips unknown keys (`packages/operations-contract/src/release-schemas.ts:64`, `z.object`), so an older
  Operations ignores it.
- **Control migration**: `runs.rollback_of TEXT NULL`; `runs.applied_ledger_json TEXT NULL`.
- **Control RPC**: `runs.rollback`, `RunDto.rollbackOf`, `RunDto.rollbackVerdict` for the latest succeeded run.
- **Application ↔ platform protocol (ADR-0062)**: unchanged. The release name, the DSN, the ingest shape and the
  `FABRIKA_*` variables stay as they are; an application on any framework release in the window is scored the same.

## Security and permissions

- `runs.rollback` is authorization in Control (`.require` plus the scoped check of `deploy.trigger`), not an
  enforcement decision; the console's session reaches it through the proxy's existing admission. It grants nothing
  `triggerDeploy` does not: a person who may deploy may deploy an older commit.
- A rollback that restores removed access parks for approval like any widening, and only a human approves
  (`packages/control/src/approval/human.ts`).
- Nothing here deploys without a person: every rollback is a `runs.rollback` call by someone who holds
  `deploy.trigger`.
- **Forged evidence.** The ingest key is public: every member SPA holds the DSN and the current release. An attacker
  can post events tagged with the current release and new fingerprints, and push the reported verdict to `suspect`.
  Reported evidence therefore only alerts and is labelled as reported, and the observed verdict, from health checks
  Operations runs itself, is kept apart. A forged alert costs attention, not a deploy. A server-only ingest key would
  make server reports count as observed; that is out of scope here.
- Audit: a rollback writes the usual `deploy.trigger` audit through the person's verified token, with `rollbackOf`
  and the verdict in its metadata. IAM's audit delivery is best-effort (backlog
  [71](../backlog/71-deliver-domain-audit-events-durably.md)).
- A rollback that narrows access depends on the IAM write after publish; while that write fails, the narrowing is not in
  force (backlog [226](../backlog/226-a-failed-iam-reconcile-leaves-a-narrowing-unapplied.md)). The rollback adds no new
  window; it inherits that one.
- The alert payload carries issue titles, as today's new-issue alert does. It carries no event payload.

## Rollout on an existing installation

1. **Generated files.** None change.
2. **Environment variables.** None added. Defaults are code constants; settings are rows.
3. **Provider state.** Unchanged. Existing runs have no `rollback_of` and no recorded ledger, so a target that
   succeeded before the upgrade reads `migrations_unknown`; a person can still roll back to it, with the snapshot
   difference shown as a hint. A run whose snapshot predates the `framework` field reads as `outside_window` unless its reader can be inferred.
4. **Floating pins.** None.

Both migrations are additive and run on `fabrika platform upgrade` with each service's own ledger. During a rolling
upgrade an older Operations ignores the `rollback` and `finishedAt` fields; an older Control sends neither.

## Test plan

- **Scoring** (Operations, pure): one new issue below threshold → reported `quiet`/`clean` with evidence listed; at
  threshold → reported `suspect`, observed unchanged; one regression → reported `suspect`; a failed check that
  recovers inside the window → not counted; one that does not → observed `suspect`; no health check → observed
  `unobserved`; a flood of forged events with healthy checks → reported `suspect`, observed `clean`.
- **Window anchoring** (Operations): a delayed projection is scored over `[finishedAt, +N]`, not its arrival; a
  duplicate delivery changes nothing; a newer run's projection arriving before an older one's leaves the older
  `superseded`; a window that ended before its projection arrived is scored at once.
- **Evidence query** (Operations repository, SQLite and Postgres; Postgres skips without `FABRIKA_TEST_POSTGRES_URL`):
  a rollback run of an earlier commit counts only occurrences inside its own window, though it shares the release row.
- **Alert**: one `suspect_release` notification per source and run across repeated maintenance passes; payload shape.
- **Verdict** (Control, pure): a ledger row added since `T` → `migrated`; a framework-bundle row added with equal
  snapshots → `migrated`; a row left by a failed run between `T` and `S` → `migrated`; a missing ledger →
  `migrations_unknown`; widening → `widens` with lines; framework outside the window → `outside_window`; `dev` →
  `not_rollbackable`; else `safe`.
- **Ledger record**: a succeeded run on a channel-serving release records the ledger; a channel that does not answer
  records none and the run still succeeds.
- **Use case**: the run's ref and commit are the target's commit; `rollback_of` recorded; stale `expectedCurrentRunId`
  → 409; denied → 404; a busy or restricted environment → 409. On the Zerops source path, a rollback run passes where a
  manual run of the branch pinned to the older commit fails `commit_mismatch` (a witness of today's behaviour).
- **Older code on a newer schema**: a witness that a release whose files are a subset of the ledger boots on both
  providers (see open question 2).

## Slicing into PRs

1. **Operations: watch windows and verdicts** (M). Migration, `finishedAt`-anchored windows, observed and reported
   scoring, maintenance evaluation, both verdicts on the release DTOs and console page. Witness: scoring table,
   anchoring and evidence query tests.
2. **Operations: the `suspect_release` alert** (S). Rule type, channel scope, payload, console settings. Witness: alert
   dedup and payload test.
3. **Control: rollback verdict and `runs.rollback`** (M). `rollback_of` and `applied_ledger_json` migration, the ledger record on
   success, pure verdict, projection fields, use case, console button on the environment page with the verdict lines. Witness: verdict and use case tests, the Zerops
   source witness.
4. **MCP and fleet read-outs** (S). Expose the verdict to the console fleet view and the operations MCP tools, after
   those specs land.
5. **Docs** (S). `reference/operations-errors.md` gains the watch window; ADR-0050 §6 a line naming `runs.rollback`
   as the rollback it describes; `ideas/operations-plane.md` drops "rollback evidence" and the question "Did the
   rollback remove the error and restore the health check?", which the rollback run's own window now answers.

PRs 1 and 3 are independent; 2 follows 1; 4 follows 1 and 3 and the specs it reads out to.

## Open questions

1. **Which target is the default?** The previous succeeded run, or the newest earlier run whose window closed `clean`?
   Default: the previous succeeded run; the console lets a person pick any earlier one.
2. **Does an older release boot on a schema that ran newer migrations?** Not confirmed in code on either provider.
   Default: the verdict stays `migrated` for any ledger row added since the target, so a `safe` verdict never relies
   on it.
3. **Which environments get a window?** Default: every non-`dev` environment with an Operations source.
4. **Spikes without a release tag.** A spike is per fingerprint, not per release. Default: count it only when its
   window occurrences carry this release.
5. **A faster rollback on Zerops** by re-activating the archived app version instead of building. Its descriptor
   carries `FABRIKA_RELEASE` ([ADR-0044](../decisions/0044-zerops-delivery-ownership-and-recovery.md)), but it skips
   Control's run, IAM schema and approval. Default: no; revisit only if build time hurts.
6. **Zerops ledger.** A `safe` verdict needs the applied ledger, which Control reads only through the Cloudflare ops
   channel today. Default: on Zerops the verdict is `migrations_unknown` and the console shows the snapshot hint, until
   its migration runner's ledger is readable by Control.
7. **Server-only ingest key.** Would let server reports count as observed evidence. Default: out of scope; health
   checks only.

## Decisions

- **Automatic rollback goes to the backlog** (review of 2026-11-04). This spec ships the watch window's warning and the
  manual rollback; the automatic rollback comes later with its own ADR,
  [backlog 273](../backlog/273-automatic-rollback-of-a-suspect-release.md).
