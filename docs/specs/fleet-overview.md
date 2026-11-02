# Fleet overview

**Summary.** One console page that lists every application environment with its owner, last human sign-in, open
issues, last release, framework lag and idle dev sandboxes, and a **retire** action that takes an unused environment out
of service before it is deleted. Size: M (the view) + M (retire).

- **Depends on:** [backlog 203](../backlog/203-deleting-an-app-or-env-leaves-its-secrets-and-iam-keys.md) for the final
  delete of a retired environment (PR 6 only). Nothing else.
- **Enables:** [backlog 266](../backlog/266-fleet-wide-framework-upgrades.md) (fleet framework upgrades read the
  framework-lag column). [Release watch window](./release-watch-window-and-rollback.md) adds its release verdict as a
  later column of this view (its own slice 5); this spec does not build it. [Agent task keys](./agent-task-keys.md) are
  refused by retire (a human action).

## Problem

Applications are cheap to start, so an installation collects them. Nobody can answer, in one place:

- Who owns this application? The registry has no such field (`apps`, `packages/control/migrations/0001_init.sql:19`).
- Does anyone still use it? IAM records each person's last sign-in per application (`app_sign_ins`,
  `packages/iam/migrations/0017_app_sign_ins.sql:7`), but answers it only per principal
  (`packages/iam/src/admin/principals.ts:67`) or per member to a `members.manage` holder.
- How far behind is its framework? Control records the pinned `@fabrika/app` release on every snapshot it reads
  (`AccessSnapshot.framework`, `packages/control/src/approval/snapshot.ts:42`), and keeps the published one in
  `app_envs.published_snapshot_json`, but no DTO or page shows it. An application that drifts to the oldest minor of the
  window ([ADR-0062](../decisions/0062-a-platform-release-serves-older-framework-releases.md)) is refused by the next
  platform release that drops that minor, and nobody sees it coming.
- Which dev sandboxes sit idle? `dev_sandboxes` holds `activity_at` and `parked_at`
  (`packages/control/migrations/0025_dev_sandboxes.sql:24`), shown only per workspace through MCP.

The console overview has an applications panel, but it reads each application's environments with a separate call and
stops at 8 applications (`OVERVIEW_APP_LIMIT`, `packages/dashboard/src/lib/overview.ts:34`; backlog 190).

And there is no way to take an unused environment out of service short of deleting it. A delete is immediate, keeps
no backup, and on Zerops is refused while the environment holds namespace claims (backlog 87).

## Design

### The view

A console page, **Fleet** (`/fleet`), one row per application environment. Each column comes from the plane that owns
it, read with the caller's own session; a plane that refuses or fails shows its columns as `forbidden` or `unavailable`
and does not take the page down (the `overviewRead` pattern, `packages/dashboard/src/lib/overview.ts:16`).

| Column           | Source                                                                                        | Plane      |
| ---------------- | --------------------------------------------------------------------------------------------- | ---------- |
| Application, env | `apps`, `app_envs` (kind, protected, authoring, domain)                                       | Control    |
| Owner            | new `apps.owner_id`; the label is resolved from IAM like audit actors                         | Control    |
| Last release     | the newest succeeded run of the environment: time, commit, actor                              | Control    |
| Framework        | `framework` of the published snapshot, against `PLATFORM_WINDOW`                              | Control    |
| Dev sandboxes    | per `dev` environment: count by state, parked count, oldest `activity_at`                     | Control    |
| Workspaces       | open workspaces (no `abandoned_at`) and the oldest one's age                                  | Control    |
| Last backup      | newest `app_env_backups` row in `succeeded`, and the schedule opt-out                         | Control    |
| Last sign-in     | latest `app_sign_ins.signed_in_at` for `<app>@<env>`, and people signed in within 30 and 90 d | IAM        |
| Issues           | unresolved issue count and the last event time of the environment's source                    | Operations |
| State            | `serving`, or `retired` with the date its retention ends                                      | Control    |

Flags the page computes from those columns, each a filter:

- **No owner**: `owner_id` is null, or IAM answers the principal as disabled or gone.
- **Unused**: no sign-in for 90 days and no succeeded run for 90 days (thresholds are constants, not configuration).
- **Framework at the floor**: the pinned minor is the oldest one `PLATFORM_WINDOW` reads
  (`packages/control/src/approval/readers.ts:150`), so a platform release that drops it refuses the next deploy.
  **Behind**: older than the platform's own minor. **Unknown**: a snapshot published before Control recorded the field
  (`snapshot.ts:42`, "Absent in a snapshot read before Control recorded it"), until the next deploy.
- **Idle sandboxes**: a `dev` environment whose sandboxes are all parked. Maintenance already parks after 30 minutes and
  removes after 14 days (`DEV_IDLE_STOP_SECONDS`, `DEV_SANDBOX_STALE_SECONDS`, `packages/control/src/dev/service.ts:23`,
  `:25`); the page shows what that leaves.
- **Orphaned sandbox host**: a namespace with `sandbox_key_ref` set and no `dev` member. This is the state of
  [backlog 245](../backlog/245-a-namespace-keeps-its-box-host-after-its-last-dev-environment.md); the page shows it, and
  245 stays the fix.

A last sign-in counts only a person's handoff into the application (`packages/iam/src/repositories/sessions.ts:136`).
Bearer, API-key and workload traffic is not a sign-in. The proxy keeps no request counter, so v1 has no request
column; "unused" means no person signed in and nobody deployed.

### Owner

`apps.owner_id`: an IAM principal id, nullable. The owner is the person to ask, not an authority: it grants nothing and
no check reads it. `apps.create` and `apps.register` set it to the calling user principal when the caller is a user;
a builder key or a service key leaves it null. `apps.update` changes it. Control does not resolve or validate the id
against IAM at write time (it holds no read of people), so the console picks the owner from IAM's people list and the
page shows an id IAM no longer answers as "unknown".

### Retire

Retiring is a reversible state between serving and deleted. It is per environment; retiring an application retires
each of its environments.

1. **Backup.** On Cloudflare, a `backup` data operation of the environment, the one the daily schedule starts
   (`packages/control/src/backups.ts`, [ADR-0070](../decisions/0070-data-protection-of-an-application-environment-on-cloudflare.md)
   §7). Today `data.start` with kind `backup` answers 501 (`packages/control/src/control-rpc.ts:798`); retire lifts that
   for itself by calling the backup path directly. The retire waits for `succeeded`; a failed backup stops the retire
   with the environment still serving. Zerops drives no data operation, so there is no platform backup: the retire asks
   the person to confirm that, and Zerops keeps the database service anyway (below).
2. **Stop serving.** On Cloudflare, a `maintenance` data operation to `closed` (ADR-0069 §3: ops requests only, no job,
   alarm or kick). A release that does not serve the ops channel answers `not_served`; see open question 3. On Zerops,
   the namespace proxy follows the registry (`namespaceMembers`, `packages/control/src/api/namespaces.ts:410`): a
   retired environment is left out of the members, and the republish drops its routes. _Assumed, not confirmed:_ the
   namespace proxy answers a host it has no member for with its unknown-host 404; PR 5 proves it with a test.
3. **Freeze.** `app_envs.retired_at` and `retired_by` are set. A retired environment refuses every run (`executeDeploy`
   and the triggers, before anything else), `bind_dev`, workspace creation and authoring.
4. **Revoke.** IAM's `workloads.revokeKeys` for each workload of the environment, and its membership key. This is item 3
   of [backlog 203](../backlog/203-deleting-an-app-or-env-leaves-its-secrets-and-iam-keys.md), done at retire instead of
   at delete; PR 5 adds the membership-key revocation 203 names as missing. In the same lease-fenced step, retire deletes
   the environment's `app_env_workload_credentials` and `app_env_membership_keys` records and their vault rows. Without
   that, the next deploy would hand the revoked keys back: both reconciles read a recorded key back while more than half
   its life is left (`packages/control/src/workload-credentials.ts:200`, `packages/control/src/membership-transport.ts:92`).
   With no record, the next deploy's reconcile issues fresh keys.
5. **Retention.** The environment stays retired for 30 days (`RETIREMENT_DAYS`, the same span after which a backup reads
   as expired). During it, **restore** reverses steps 2 and 3: it clears `retired_at`, opens the object at a new
   generation (Cloudflare) or returns the environment to its namespace members (Zerops), and then redeploys the newest
   succeeded run under the same lease, as a side restore's deploys do (`operationDeploys`). That deploy issues fresh keys,
   so the running version never keeps a revoked one.
6. **Delete.** After the retention the page offers the ordinary delete (`deleteAppEnvUseCase`,
   `packages/control/src/api/registry/environments.ts:156`; `deleteAppUseCase`, `apps.ts:52`). Maintenance never deletes
   on its own. The delete keeps its current rules: the human check for a protected environment, the dev-sandbox check
   and, on Zerops, the claims refusal of backlog 87. Fabrika deletes no provider resource
   ([ADR-0034](../decisions/0034-the-control-plane-creates-the-projects-it-owns.md)), so the Worker, its object and
   its R2 dumps on Cloudflare, and the services on Zerops, stay at the provider; the page lists them as left behind.

Retire runs as a job under the environment's `<app>:<env>` deploy lease, like a data operation, so it cannot race a
deploy. Each step is recorded on a `app_env_retirements` row fenced on the lease, so a successor resumes it.

### Relation to backlog items

| Item                                                                                   | Relation                                                                                                                           |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| [172](../backlog/172-a-list-of-values-cannot-show-each-values-last-sign-in.md)         | Left. 172 is a per-value aggregate inside an application, for its staff; this is per environment, for installation administrators. |
| [190](../backlog/190-the-overview-reads-each-applications-environments-separately.md)  | Consumed. `fleet.list` answers every environment in one call; the overview's applications panel moves onto it and 190 is deleted.  |
| [203](../backlog/203-deleting-an-app-or-env-leaves-its-secrets-and-iam-keys.md)        | Item 3 consumed by retire (PR 5). Items 1–2 (vault rows) stay 203's and block PR 6.                                                |
| [245](../backlog/245-a-namespace-keeps-its-box-host-after-its-last-dev-environment.md) | Left. The page flags an orphaned host; 245 removes it.                                                                             |
| [247](../backlog/247-dev-sandbox-size-is-not-a-namespace-policy.md)                    | Left. The page shows counts, not sizes.                                                                                            |

### Cost

Out of v1. No provider package reads billing data today, and both clouds bill per account or project, not per
application environment (on Zerops several environments share one namespace project). A per-environment cost would be
an estimate from reserved resources, which the page could add later without a contract change.

## API and contract changes

**Control** (`@fabrika/control-contract`, `packages/control/src/control-rpc.ts`):

- `fleet.list` → `{ platform: { release, floor }, items: FleetEnvironmentDto[] }`. One call, every environment of every
  application the caller holds global `app.manage` on (as `apps.list`, `control-rpc.ts:308`). Each item: the columns of
  the Control plane above. Bounded: the registry is small, but the query reads aggregates (counts, max) per environment,
  not rows.
- `AppDto.ownerId: string | null`; `apps.update` accepts `ownerId`.
- `AppEnvDto.framework: string | null` (the published snapshot's pin) and `AppEnvDto.retired: { at, by, until } | null`.
- `apps.environments.retire({ appId, env, acknowledgeNoBackup? })`, `apps.environments.restore({ appId, env })`. Both
  start a job and return the retirement record; `apps.environments.retirement({ appId, env })` reads its progress.
- Migration `0031_fleet.sql` in `migrations/` and `migrations-postgres/`: `apps.owner_id`, `app_envs.retired_at`,
  `app_envs.retired_by`, and `app_env_retirements` (id, app, env, step, backup id, outcome, actor, timestamps). Each
  column is nullable; no backfill.

**IAM** (`@fabrika/iam-contract`, the admin RPC behind the console's IAM gateway):

- `apps.signIns({ apps: string[] })` → per IAM application id `<app>@<env>`: `lastSignInAt`, `people30d`, `people90d`.
  No principal id, no address. One query over `app_sign_ins`, grouped by `app`. No migration: the table has
  `PRIMARY KEY (app, principal_id)`, which the grouping uses.

**Operations** (`@fabrika/operations-contract`, `packages/operations/src/operator-rpc.ts`):

- `sourceSummaries` → per source the caller may read under `operations.read`
  (`authorizedSources`, `packages/operations/src/operator-api/sources.ts:13`): unresolved issue count, last event time,
  latest release. One grouped query; today the console would need one `issues` call per source.

**Console** (`packages/dashboard`): the `/fleet` route, a nav entry shown under `mayOpen(caller, 'index')`'s rule
(`packages/dashboard/src/lib/console-access.ts:85`), the owner picker on the application page, and the retire, restore
and delete actions with their confirmation.

**Protocol (ADR-0062).** None of this touches the protocol between an application and the platform. The framework column
reads what Control already records from `bun.lock` (`packages/control/src/approval/read.ts:60`). Closing the object uses
the existing ops channel at releases that serve it, and changes nothing an application receives.

## Security and permissions

- **Reading the page.** Control columns need global `app.manage` (`fleet.list`). The sign-in columns need `iam.admin`,
  or `iam.users.manage` in that `<app>@<env>` value (`packages/iam-contract/src/access.ts:9`); IAM filters the answer
  per value and audits the read, as every admin read. Operations columns need `operations.read` per source. A caller
  sees exactly what each plane answers it; there is no fleet-wide role.
- **Sign-in aggregates are personal data at the edges.** For an environment with one user, `lastSignInAt` is that
  person's last sign-in. That is why it is answered only to an IAM administrator of the application, who can already read
  each person's sign-in on the principal page (`principals.ts:67`). The 30/90-day counts reveal no one.
- **Retire and restore.** A human user principal in the console (no OAuth claims, no link claims, no bearer), holding
  `app.manage` and `data.manage` at the environment. Retire and restore call `requireHumanApprover`
  (`packages/control/src/approval/human.ts:19`) unconditionally, then `requireHumanForProtectedDelete` (`:33`) for
  `access.approve` on a protected environment. The second check alone is not enough: it returns at once when no
  environment is protected (`:35`), so on an unprotected environment it would let any credential through. A builder key,
  an MCP token, a service key or an agent task key is refused.
- **Confirmation.** The console asks for the environment id typed out, and on Zerops the explicit "no platform backup"
  acknowledgement (`acknowledgeNoBackup: true`), which the RPC refuses to infer.
- **Audit.** `app.env.retire`, `app.env.restore`, `app.owner.set`, each with the actor; the backup and the maintenance
  transition audit as the data operations they are.
- **No new secret.** Retire revokes the environment's IAM keys and deletes their records and vault rows. App secrets,
  proxy secrets and token keys stay for a restore; their vault rows go with the delete (203).

## Rollout on an existing installation

1. **Generated files.** None change. No sidecar workflow, `zerops.yaml` or import YAML is touched.
2. **Environment variables.** None added or renamed. Retire deletes the key records, so the redeploy a restore runs
   issues fresh keys through the existing reconcile and writes them over the revoked ones.
3. **Provider state.** Nothing a provider created is checked differently. On Zerops, a retired environment leaves the
   namespace members, so the next republish drops its routes; the services stay as they are.
4. **Floating pins.** None.

Existing applications start with `owner_id` null and show **No owner** until someone sets it; Control does not guess
one from run actors. Existing environments show framework **Unknown** until their next deploy publishes a snapshot with
the field. Migration `0031` is additive on both dialects.

## Test plan

- **Registry (both dialects):** `owner_id` round-trips through `apps.create`, `apps.register` (set to the user caller,
  null for a builder key) and `apps.update`.
- **`fleet.list`:** a fixture with three applications covers each flag: no owner, framework at the floor (a snapshot
  pinning the oldest reader's minor), unknown framework (a snapshot without the field), idle sandboxes, orphaned host;
  a caller with `app.manage` scoped to one application is refused.
- **IAM `apps.signIns`:** answers the latest sign-in and the counts per `<app>@<env>`; a `users.manage` holder in one app
  gets only that app; no answer carries a principal id.
- **Operations `sourceSummaries`:** counts unresolved issues per source and omits sources outside the caller's grants.
- **Retire on Cloudflare:** backup, `closed`, revocation, `retired_at`, in order; a failed backup leaves the environment
  `open` and serving; a deploy of a retired environment is refused; restore opens at a new generation; a Control
  restart mid-retire resumes from the recorded step.
- **Keys after a restore:** retire → restore → its redeploy hands a workload key and a membership key that differ from
  the revoked ones, and a job of the restored environment mints a token with its key. Retire leaves no
  `app_env_workload_credentials` or `app_env_membership_keys` record and no vault row of theirs.
- **Retire on Zerops:** refused without `acknowledgeNoBackup`; the namespace job's members omit the retired environment;
  the proxy answers its host 404 (the assumption above).
- **Authorization:** on an unprotected environment, retire and restore are refused to an MCP (OAuth) token, a builder
  key, a service key and a session without `data.manage`; on a protected one, also to a person without
  `access.approve`.
- **Console:** the page renders each column's `forbidden` and `unavailable` state without hiding the others.

## Slicing into PRs

1. **Owner field (S).** Migration, `AppDto.ownerId`, create/register/update, the console picker. Witness: the registry
   test on both dialects.
2. **`fleet.list` and the framework column (M).** The Control read, `AppEnvDto.framework`, the platform window in the
   answer; the overview's applications panel moves onto it and backlog 190 is deleted. Witness: the flag fixture test.
3. **IAM sign-in aggregates and Operations summaries (S).** `apps.signIns`, `sourceSummaries`. Witness: their tests.
4. **The fleet page (M).** `/fleet`, flags as filters. Witness: the dashboard test of per-plane failure states.
5. **Retire and restore (M–L).** The job, the record, the Cloudflare backup and `closed` path, the Zerops member
   removal, the key revocation (203 item 3), the console actions. Witness: the retire tests on both providers.
6. **Delete after retention (S).** The console's delete of a retired environment once its retention ended. Blocked by
   203 items 1–2, so a delete stops leaving vault rows. Witness: a retired-then-deleted environment leaves no vault row.

PRs 1–4 ship the view alone; 5–6 are independent of the view's columns.

## Open questions

1. **Retention length.** Default: 30 days, the span after which a backup reads as expired. A per-installation setting
   only on request.
2. **Automatic delete after retention.** Default: no. Maintenance flags the environment as due; a person deletes it.
3. **A Cloudflare release that does not serve the ops channel.** It cannot be closed. Default: retire is refused for it
   with "deploy a release that serves the ops channel first"; the page names the release floor.
4. **Stopping Zerops services.** Removing the routes stops traffic, not cost. Default: v1 leaves the services running
   and lists them; a provider capability to stop them is a later decision (fabrika deletes no provider resource, but
   stopping is not deleting).
5. **Who sees sign-in aggregates.** Default: `iam.admin`, and `iam.users.manage` in that application. A wider audience
   needs the same privacy decision as backlog 172.
6. **Non-human activity.** API keys and workloads have no "last used" record. Default: out of v1; "unused" means no
   human sign-in and no deploy.
7. **An ADR.** Retirement is a new lifecycle state of an environment and constrains every deploy path. Default: write
   one with PR 5 ("An application environment is retired before it is deleted"), naming ADR-0034's no-provider-delete
   rule as unchanged.
