# Access diff as a GitHub check

**Summary.** On every pull request to a connected repository, Control classifies the head commit's access against
the approved snapshot of each environment the merge will reach, and posts the result as a GitHub check run. A reviewer
sees "this widens access" on the pull request, before anyone deploys.

**Size.** S–M: five pull requests, the first and the last small.

**Depends on.** Nothing new. It reuses the snapshot reader and classifier of
[ADR-0050](../decisions/0050-approved-access.md) and the GitHub App of [ADR-0029](../decisions/0029-github-app-sources.md).

**Enables.** Backlog 266 (fleet framework upgrades): its upgrade pull requests carry this check, including a
"this platform does not read that framework release" failure. Pull requests from MCP workspaces
([ADR-0049](../decisions/0049-author-applications-through-mcp-in-control.md)) and local builders
([ADR-0042](../decisions/0042-connect-local-builders-through-human-consent.md)) get it without change.
[Release watch window](./release-watch-window-and-rollback.md) and [access simulator](./access-simulator.md) are
independent.

## Problem

ADR-0050 shows a widening at deploy time, in the console, and only a protected environment waits for a human. The
pull request that introduced the widening was reviewed earlier, on GitHub, where nothing says "role `sales` may now
delete companies". A reviewer must read `fabrika.contract.ts`, `src/db/tables.ts` and the migrations and work out the
effect alone. On an unprotected environment (stage, an authoring target) the widening applies at once, so the pull
request is the only review it gets. An agent that loosens a contract to get past a 403 is caught only if the reviewer
notices.

Control already computes exactly this answer for a deploy run, from a pinned commit. It never computes it for a
commit that is only proposed.

## Design

### What exists

- `readAccessSnapshot(commit, root, appId, settled)` (`packages/control/src/approval/read.ts:113`) reads a commit's
  contract, tables and migrations through the reader of the framework release the commit's `bun.lock` pins
  (`readerFor`, `packages/control/src/approval/readers.ts:165`). It executes nothing from the checkout and refuses with
  fixed codes only (`SnapshotRefused`, `read.ts:90`).
- `approvedSnapshot(appEnv)` (`packages/control/src/approval/snapshot.ts:170`) is the environment's published
  baseline, or the empty one.
- `classifyAccess(baseline, candidate)` (`packages/control/src/approval/diff.ts:109`) is pure. It returns the outcome
  (`none`, `no-widening`, `widening`) and the lines, each with its effect, words, rule, subject and audience.
  `snapshotDigest` (`snapshot.ts:120`) gives the two digests an approval binds to.
- `publishRunSnapshot` (`packages/control/src/approval/publish.ts:150`) is the one place that composes them for a run.
  The new path composes the same three functions and writes nothing to `runs` or `app_envs`.
- The webhook route verifies the connection's HMAC and acts on `push` only; every other event is a 204
  (`packages/control/src/github/triggers/push-event.ts:173`, `packages/control/src/github/triggers/webhook.ts:41`).
- The App manifest asks for Contents and Pull requests write and the `push` event only
  (`packages/github-app/src/manifest.ts:31-32`). Control re-verifies that the App subscribes to exactly `push`
  (`packages/control/src/github/connections/port.ts:135-136`, `configuration.ts:83-98`).

### Trigger

The App subscribes to `pull_request` and `check_run` too. The webhook decodes a verified `pull_request` delivery with
action `opened`, `synchronize`, `reopened`, or `edited` with a changed base, into: repository URL, installation id,
pull request number, head SHA, base ref, and whether the head repository is a fork. It parses it once, at the route,
with a zod schema beside `pushPayloadSchema` (`push-event.ts:159`). It matches the repository to apps exactly as a push
does (`getConnectionApps`, `webhook.ts:81`), so a connection never triggers another connection's apps.

The route reads no code. It enqueues one job per app, `{ kind: 'pull_request_access', connectionId, installationId,
appId, pullNumber, headSha, baseRef }`, on the existing queue (`ControlJobMessage`,
`packages/control/src/run-lifecycle.ts:197`), and answers 202. A `check_run` delivery with action `rerequested` for a
check this App created enqueues the same job for that head.

### Which environments are compared

For each app, the job compares against:

1. every non-`dev` environment whose `trigger_ref` matches `refs/heads/<base>` (`refMatches`, the push rule): the
   environments the merge deploys to, and
2. every `protected` environment of the app, even when the merge does not deploy it directly (production on a
   `refs/tags/v*` trigger is the common case). Its check title says it is compared with what that environment runs
   now, not deployed by this merge.

A `dev` environment is never compared: it runs unreviewed workspace heads and is never protected (ADR-0050 §4). One
check run per compared environment, named `fabrika access (<env>)`, so branch protection can require one by name.

### Computing

The job opens the head commit once through `CommitSource.open` with the connection's `sourceBinding` and
`snapshotReads(root)`, where `root` is `provider.applicationRoot(source)` as the deploy computes it
(`run-lifecycle.ts:730`). Per environment it calls `readAccessSnapshot` with that environment's published migrations
as `settled`, then `classifyAccess` against `approvedSnapshot(appEnv)`. The commit's files are read once; only the
classification repeats.

Cost per push to a pull request: one snapshot read of the head, as a deploy pays. On Zerops that is one archive pass
(ADR-0029). On Cloudflare it is the tree and the wanted files through the metadata client, counted against the
installation's own limit, not the anonymous one. Bounds are `SNAPSHOT_LIMITS` (`read.ts:21`).

**Dedupe.** A row in a new table, unique on `(app_id, env, head_sha, baseline_digest)`, records the candidate digest,
outcome, stored classification, check run id and pull request number. A redelivered webhook, a reopened pull request
or a second `synchronize` to the same head finds the row and only re-posts the check if GitHub lost it. A
`rerequested` check reads the baseline again: the same digest re-posts the stored result, a new one computes.

**Stale baseline.** When an environment publishes a new generation, an open pull request's check still names the
older baseline. The check summary says which baseline it read ("compared with the access `prod` published on
<date>"). Slice 5 refreshes open pull requests after a publication, selecting them by the same rule as the initial
check; until then, "Re-run" recomputes.

### The check run

| Outcome                                             | Conclusion | Title                                                 |
| --------------------------------------------------- | ---------- | ----------------------------------------------------- |
| `none`                                              | `success`  | No access change on `<env>`                           |
| `no-widening`                                       | `success`  | Narrows access on `<env>` (N lines)                   |
| `widening`, environment not protected               | `neutral`  | Widens access on `<env>`: applies at deploy (N lines) |
| `widening`, environment protected                   | `neutral`  | Widens access on `<env>`: needs approval at deploy    |
| `ContractMissing`, `FrameworkReleaseRefused`, codes | `failure`  | The deploy would refuse this commit                   |
| Source unavailable after retries                    | `neutral`  | Access not checked: the commit could not be read      |

`neutral` passes a required check on GitHub; `action_required` and `failure` do not. A widening is information here,
not a refusal: the gate stays the deploy-time approval. A refusal is a `failure` because the deploy would fail the same
way, for the same reason.

The summary leads with who gains access, as the approval page does (ADR-0050 §7): widening lines grouped by audience,
closer-review lines marked, then narrowing and neutral lines. It renders `AccessChangeDto` lines; it adds no wording of
its own. GitHub caps a summary at 65,535 characters; past a fixed bound the summary stops and says how many lines the
console page holds. `details_url` is the console page of slice 4, or the environment's page before it.

### Approving from the pull request

Not in this spec. ADR-0050 §5 binds an approval to a run and its two digests, and a pull request head is not what
deploys: the merge commit can differ in access. A console decision that flips the check would need a pre-approval of a
digest pair that a later run consumes when its digests match. That rewrites ADR-0050 §5; see open questions.

## API and contract changes

- **`@fabrika/github-app`.** The manifest adds `checks: 'write'` and the events `pull_request` and `check_run`.
  `GitHubAppIdentity.permissions` decodes `checks`. A new client method mints a token with `{ contents: 'read', checks:
  'write' }` for one repository and returns a client with `createCheckRun` and `updateCheckRun` only. The deploy
  token stays Contents read (`client.ts:177`); the authoring token is unchanged (`client.ts:185`).
- **Control identity checks.** `verifiedIdentity` (`port.ts:127`), `validateIdentity` and `matchesConnectionIdentity`
  (`configuration.ts:83`, `:92`) accept an App whose events are `push` alone or `push` with any of `pull_request` and
  `check_run`; any other event is still refused. The connection records whether checks are available: `on`, `off` (the
  App lacks the permission or the events), or `awaiting_acceptance` (the installation has not accepted). The
  connection's App DTO stops hard-coding `permissions: { contents: 'read' }` and `events: ['push']`
  (`packages/control/src/github/connections/status.ts:139-140`) and reports the verified permissions and events, so
  the console shows what the App actually holds.
- **Webhook.** `VerifiedDelivery` gains `pull_request` and `check_run` kinds, and an `installation` delivery with action
  `new_permissions_accepted` refreshes the connection's check state.
- **Queue.** `ControlJobMessage` gains `PullRequestAccessJobMessage`. The consumer refuses an unknown kind by throwing
  (`packages/control/src/consumer.ts:97`), so during a rolling deploy an older consumer retries the message rather than
  mis-running it.
- **Control contract.** `GitHubSourceConnectionAppDto.permissions` gains `checks?`, and the connection status DTO
  gains `checkRuns: 'on' | 'off' | 'awaiting_acceptance'`. Slice 4 adds a read procedure
  `apps.environments.pullRequestAccess.get` behind `deploy.read` at the coordinates, answering the stored
  classification in the approval page's DTO shape.
- **Schema.** One Control migration, in `migrations/` and `migrations-postgres/` (`packages/control/DATABASE.md`): the
  table `pull_request_access_checks` and a `check_runs` column on the connection row.
- **Application protocol (ADR-0062).** None. No manifest row, header, claim, contract format or variable changes. The
  head is read with the reader of the release it pins, as a deploy reads it; a release outside the window is a
  `failure` check, as it would be a failed run.

## Security and permissions

- **New permission.** `checks: write` is the only new permission. Subscribing to `pull_request` needs Pull requests
  read, which the App already holds as write; `check_run` comes with Checks. No token used by this path carries a write
  permission other than Checks.
- **Existing installations re-approve.** A manifest applies only when an App is created. On an existing App the
  operator adds Checks write and the two events in the App's settings on GitHub; GitHub then asks the owner of each
  installation to accept, and until then the installation's tokens lack Checks. Control learns it in two ways: minting
  a token with `checks: write` fails, which records `awaiting_acceptance` and skips the check without retrying; and
  the `installation` delivery `new_permissions_accepted` sets `on`. The console shows the state on the connection.
  Deploys never depend on it.
- **Forks.** GitHub delivers `pull_request` for a fork of a connected private repository to the base repository's
  installation. The head commit is read through the base repository by SHA. That GitHub serves a fork head's tree
  and archive this way is assumed, not confirmed; slice 2 verifies it and, if not, records `neutral` "not checked"
  for forks. Reading a fork head is safe in kind: the reader executes nothing (ADR-0005), and its errors are codes. The
  cost is bounded by the dedupe row and a per-connection cap on running jobs.
- **Who sees the diff.** Anyone with read access to the repository sees the check output. Its lines come from the
  head's contract and the published snapshot, which itself came from a commit of the same repository. It names no
  run, approver, secret or the environment's cross-origin list (that list is not part of a change, ADR-0050 §3). It
  does reveal what an environment runs now, which a reader of the repository may not otherwise know; see open
  questions. The console page needs `deploy.read` at the coordinates.
- **Vocabulary (ADR-0022).** The check is information. It is not enforcement (the proxy still makes the only
  decision), not authorization (the deploy approval still needs `access.approve` from a human user principal,
  `packages/control/src/approval/human.ts:19`), and not admission. The webhook stays the one HMAC-authenticated
  protocol route.
- **Logs.** The job logs codes and counts, as the run log does (`publish.ts:227-233`); never checkout text, a token
  or the error object.

## Rollout on an existing installation

1. **Generated files.** None. The sidecar workflow, `zerops.yaml` and import YAMLs are unchanged. The App lives on
   GitHub, and `upgrade` cannot change its permissions. The operator step goes into `docs/reference/` beside the
   existing step that raises the App to write for MCP authoring (`docs/reference/mcp-authoring.md`, "Give the GitHub
   App write access").
2. **Environment variables.** None.
3. **Provider state.** An App made before this change subscribes to `push` only and keeps passing: Control reports
   checks `off`. The order matters: an App edited to subscribe to `pull_request` fails today's identity check
   (`port.ts:135`), so `source.connection.reconcile` would answer 409. Slice 1 ships the relaxed check first; the
   reference step says to upgrade before editing the App.
4. **Floating pins.** None.

## Test plan

- **Identity.** An App with `push` only, with `push` + `pull_request` + `check_run`, and with an extra event: the first
  two verify and record `off`/`on`; the third is refused (`connections/__tests__`).
- **Webhook decode.** A signed `pull_request` delivery for each action, a fork head, an unsigned one (401), a repository
  bound to another connection (204, nothing enqueued), a `closed` action (204).
- **Job.** On the in-memory harness with a fake GitHub: a head that adds a public endpoint yields a `neutral` check on
  `stage` (matched by trigger) and on `prod` (protected), with the widening line; an unchanged head yields `success`; a
  head without `fabrika.contract.ts` yields `failure` with the fixed line; a second delivery for the same head posts
  nothing new; a new baseline after a publication recomputes on `rerequested`.
- **No leak.** A refused snapshot whose files carry a secret-shaped string: the check output and the log hold only
  the code (pattern of `github/source/__tests__/no-leak.test.ts`).
- **Permissions.** A mint that GitHub refuses for Checks records `awaiting_acceptance` and posts nothing; the deploy of
  the same app still succeeds.
- **Live.** One manual pass on a real App with a real pull request, recorded in the slice's PR, as backlog 196 does for
  MCP authoring.

## Slicing into PRs

1. **Accept the wider App (S).** Relax the three identity checks, decode `checks`, report the verified permissions
   and events in the connection DTO (`status.ts:139-140`), record the connection's check state with a per-connection
   opt-out, change the manifest for new Apps, document the operator step and rewrite ADR-0029's "the `push` event only".
   Witness: the identity tests above.
2. **The check (M).** Webhook decode, the job, the dedupe table and migration, the Checks client, the summary renderer
   and the conclusion table. Witness: the job tests and the no-leak test.
3. **Re-run and acceptance (S).** `check_run` `rerequested`, `installation` `new_permissions_accepted`, the connection
   state in the console. Witness: a rerequest recomputes against a new baseline; an acceptance flips `awaiting_acceptance`
   to `on`.
4. **Console page (M).** `apps.environments.pullRequestAccess.get` and a read-only page that renders the stored
   classification with the approval page's components; `details_url` points to it. Witness: the procedure answers 404
   without `deploy.read` at the coordinates; the page renders a fixture.
5. **Refresh after publication (S).** After an environment publishes, enqueue the job for every open pull request
   (bounded) whose compared set, by the selection rule of "Which environments are compared", includes that
   environment: those whose base its trigger matches and, for a protected environment, every open pull request of the
   app's repository. Witness: a publication re-posts a stale check, including a `prod` publication triggered by a
   `refs/tags/v*` tag (`webhook.ts:58`, `poll.ts:145`), which refreshes a pull request to `main`.

## Open questions

1. **Approve from the pull request?** A console pre-approval of a digest pair that a run with the same digests
   consumes, flipping the check to `success`. Default: no in this spec; decide after slices 1–4 run, as a rewrite of
   ADR-0050 §5.
2. **Compare with protected environments the merge does not deploy?** Default: yes, as listed above; the title says it.
3. **Forks.** Default: check them, bounded. Alternative: skip forks, since a fork author can probe the published access
   one push at a time.
4. **Showing what production runs.** The check reveals the published access to every reader of the repository.
   Default: accept it, since that access came from the same repository; an installation that disagrees turns the
   check off per connection (the opt-out of slice 1).
5. **Draft pull requests.** Default: check them too; the dedupe bounds the cost.

## Decisions

- **Slice 1 ships first, ahead of the rest** (review of 2026-11-04). Every installation's operator must re-approve the
  wider GitHub App before a check can run, so Control accepts the wider App in the first wave and the operator step is
  documented then; slices 2–5 follow in the next wave, by which time the approvals have had time to land.
