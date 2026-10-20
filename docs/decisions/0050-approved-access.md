---
id: 0050
title: Publish only approved access
status: accepted
date: 2026-10-20
---

# 0050 — Publish only approved access

## Context

An application declares its access surface in one contract and its table policies
([ADR-0012](0012-fabrika-app-runtime.md)). The proxy enforces the contract per endpoint
([ADR-0022](0022-the-proxy-is-the-only-enforcement-point.md)), and IAM holds the roles. Both read what
Control publishes.

Handlers are arbitrary TypeScript on a paved road scoped by the endpoint's capability. A step off that road — raw
SQL, a table read without its scope, a connector call, share-link issuing, database code in a migration — is
allowed, because refusing it only teaches the agent to work around the refusal. It is declared instead: in the
contract, or by the migration file itself ([ADR-0017](0017-service-owned-postgres-migrations.md)). A declaration is
worth something only when the person who approves the deploy sees it.

The person who drives a coding agent often does not read the diff. The agent is competent but
optimizes for "it works". When a request is refused, it loosens whatever refused it: an endpoint's
callers, a role's actions, a table policy. Two authoring paths reach the platform: a local agent with a
builder key ([ADR-0042](0042-connect-local-builders-through-human-consent.md)), and a hosted agent over
MCP ([ADR-0049](0049-author-applications-through-mcp-in-control.md)). In both, a widened contract is
visible only in the pull request, and nobody has to look at it.

Today Control has no record of what access an environment has. `app_envs.provider_artifact_json` is one
mutable value. Several paths publish a proxy manifest or reconcile IAM from it: the deploy,
`apps.environments.put`, namespace reconcile and the provider's reconcile paths. The IAM schema comes
from the uploaded artifact on Zerops and from the runner's outcome on Cloudflare. Each of these is a
self-report of the build the agent controls.

## Decision

**We will publish an application's access only from an approved snapshot, and we will make every
widening on a protected environment wait for a human.**

Built in work unit B6 (`packages/control/src/approval/`). Details the sections below leave open:

- The migration checksum is the SHA-256 of the file's text, the checksum the application's ledger records;
  every file under `db/migrations/` is listed.
- The snapshot digest covers the canonical contract (each site's declared reach included) and the migration list,
  and the database code only when there is some; not the checker version. It keeps the trailing `null` that once
  stood for artifact access, and the contract's `declared` section is absent for a contract that is not built with
  the staged kit, so a digest an approval recorded stays valid.
- **Fabrika deploys an application only with a contract.** A commit without `fabrika.contract.ts` fails its
  run before any provider is called (`ContractMissing`), on every environment, protected or not, and publishes
  nothing; the approved contract stays published. A run snapshot stored without a contract is refused the
  same way. The trusted installation deploy needs no contract: on Cloudflare the deployer's
  `platformResources: 'allow'`, on Zerops the platform deploy. Neither runs through Control's application path.
- There is one kind of approved access, the contract. A provider receives it as `ProviderEnvironment.access`.
  Without approved access a provider routes nothing, reconciles no IAM schema and refuses a non-dry deploy.
  The Cloudflare deployer refuses an application checkout without a contract and a config that declares
  `gates`; the Zerops manifest parser refuses `proxy.gates`.
- A stored snapshot may still hold the `artifact` access of an application published before contracts
  were required. It parses with that field dropped. A publication without a contract approves nothing:
  `approvedSnapshot` reads it as the empty baseline, so the application's first contract is a widening
  that a human approves on a protected environment. The empty unpublished baseline stays valid.
  `runs.pending_access_json` is no longer read or written; a later migration drops it.
- The published snapshot is stored on `app_envs.published_snapshot_json`, written by the same
  compare-and-swap as `published_run_id`.
- Control reads the snapshot at the provider's `applicationRoot`, the directory the provider executes
  from, with the same normalization (`checkoutRelativeDirectory` on Cloudflare). A root outside the
  repository fails the run.
- The Cloudflare runner job carries the approved access: the contract and its digest. The runner hands it to the executor in a file beside the checkout. The deployer builds the
  proxy table and `FABRIKA_CONTRACT_DIGEST` from it, never from the checkout. Every framework variable
  in each generated wrangler config must equal the value the platform wrote, so a binding's
  `configureBinding` cannot overwrite the digest.
- The snapshot is logged before the run's secrets are known, so redaction cannot cover it. Its log
  lines carry fixed codes and counts only, never a name from the checkout. The change lines stay in
  the classification the approval page shows.
- A run records its actor as `user:<id>`, `service:<id>`, `oauth:<id>`, `webhook:<connection>` or `poll`.
- `approvals.complete` approves or refuses; a refused run fails. The protected flag changes through
  `apps.environments.protect`. A parked run can be cancelled.
- A provider that pins no commit (`resolveSource` absent) reads no snapshot and publishes nothing new.

### 1. A deploy run holds the snapshot

Right after a run's commit is pinned, Control reads the application's shell — the contract and the modules it
imports, `src/db/tables.ts` — and the migration files at that commit. It parses the shell with the static reader of
[ADR-0005](0005-compile-app-config-to-static-manifest.md), each module as its shell slice: the handlers are removed
first, so Control never fetches, parses or runs a module that only a handler imports. It classifies the migration
files with the classifier the runner applies them with ([ADR-0017](0017-service-owned-postgres-migrations.md)). The
run stores the result as its **snapshot**:

- the parsed contract and table policies, with each site's **declared reach** (`ContractArtifact.declared`): the
  `sql` mode, the `unscoped` tables and their modes, the `connect` imports, the `issues` mount, the `kicks` jobs, the
  `binds` webhook, the `signs` purposes, the `egress` origins and a public procedure's workload `actions` of each
  endpoint, job and webhook that declares any;
- the migration list with checksums;
- the **database code** the migrations declare (`databaseCode`): each function, procedure, trigger, view, rule,
  policy, `DO` block and expression that calls database code, by file, kind and object;
- the checker version;
- the baseline the candidate was compared with;
- the approval, when one was needed.

The declared reach and the database code are the snapshot's **deviations**: the steps off the paved road. Nothing
else of the handler code reaches the snapshot; the checker's structure hints stay checker output.

A migration file the classifier refuses (an escape from the schema, the transaction or the platform) fails the
read, as the runner would refuse it, except a file the environment's published snapshot holds with the same
checksum: the runner skips an applied file, so a stricter classifier cannot lock an application out. The read is
bounded: 256 shell files, and 16 Mi characters of migration text, which the classifier reads at once.

Uploads carry no proxy table and no IAM schema. A snapshot comes only from the commit.

### 2. Publication is a compare-and-swap on the environment

`app_envs` gains `published_run_id`, `generation` and `protection_revision`. The published run's
snapshot is the environment's **active snapshot**.

One function, `approvedSnapshot(app, env)`, feeds every path that publishes a proxy table or
reconciles IAM:

- the deploy;
- `apps.environments.put` and `delete`, and `apps.delete`;
- `namespaces.reconcile` and the namespace jobs;
- the Zerops `reconcile-schema` step, cancel and reconcile;
- the Cloudflare deploy and reconcile.

A run publishes with `UPDATE … WHERE generation = ? AND protection_revision = ?`, inside the existing
namespace lease. A concurrent publication therefore loses. A change of the `protected` flag advances
both values, so a run that classified under the old flag also loses. A registry write advances
`generation` too. The counters are monotonic per `<app>@<env>` and survive deletion (section 4).
`apps.environments.put`, `apps.environments.delete` and `apps.delete` apply only while the environment
is at the generation they read, so a protection change between their check and their write refuses them.
A refused put commits nothing, its namespace claims included.

Every write of an `<app>@<env>` — create, put, delete, protection change, publication — first ensures
the coordinates' `app_env_protection` row and locks it, and only then reads the tombstone or the
environment. A write that may create an environment, and an application's deletion, lock the `apps`
row first. On Postgres concurrent writes of one environment therefore run one after another; SQLite
and D1 run one batch at a time anyway.

A protection change takes the environment's deployment lease and is refused (409) while a run holds it
or is still `running` without it: a job deploys what the flag allowed when it started.

A run that loses the compare-and-swap is classified again against the new active snapshot. This holds
while the run waits and after it is approved. An approval is valid only for the baseline digest it
recorded. When the new diff still widens, the run needs a new approval.

**Invariant: a pending change is published nowhere.** No path publishes a proxy table or reconciles IAM
from anything other than `approvedSnapshot(app, env)`.

### 3. Classification is a conservative diff

Control compares the normalized access data of the candidate snapshot with the environment's active
snapshot. An environment with no published run has the empty snapshot as its baseline. The comparison
covers:

- endpoint callers, access forms (the `app` form named as a global grant, each capability of `capabilities` by its
  name and form), input domains and output shapes (a file output by its kind, a `redirect()` by where it may send a
  caller), and each endpoint's HTTP shape;
- containment, roles and their actions, membership rules;
- table and column policies, with the actions each column is read and written with; a new application table
  (`scope: { app }`) is shown with its reason and every action. A table operation that names a list of actions is
  compared by action: an action the list gains widens, one it loses narrows;
- anonymous kinds (a new public SPA, or an SPA that becomes public, widens) and link mounts;
- **public procedures**: a new one, or an endpoint that becomes public, widens with closer review ("for anyone,
  without signing in"), and so does each workload action it gains ("runs as its own workload with `<action>`, for
  anyone who calls it"); a lost action narrows. These actions are no step off the road, so the environment's deviation
  list does not show them ([ADR-0063](0063-a-public-procedure-runs-as-its-own-workload.md));
- **each procedure's admission and limits, by their effective values**: its buckets, its challenge, its time limit and
  its body limit, derived ones included, on every new procedure and on every procedure the baseline records no rules
  for (every one, when an application moves from an older framework release). A bucket raised or turned off, a dropped
  challenge, a longer time limit and a larger body limit widen; the reverse narrows. On Zerops the per-client bucket is
  shown as counting one client. A public `GET` query's `http.cache` shows how long its answers are reused, and that
  `immutable` needs an input that names a value that never changes. A `GET` mutation reads "changes state on GET; link
  scanners may trigger it" and widens with closer review;
- **file kinds and file columns** ([ADR-0061](0061-a-file-is-a-value-in-a-table-column.md)): a new kind is a neutral
  line with its types, size limit and scan, since a kind adds no authority; a new type, a larger limit and a dropped
  scan widen. File reach follows table reach: each action that writes a file column is shown as "`deals.write` writes
  `deal_attachments.file` (attachments)", and a column that starts or stops holding files, or changes its kind, is its
  own line;
- job and webhook actions and time limits (a longer one widens), a new webhook's verifier and binding, connector
  exports and imports;
- **kick edges** ([ADR-0060](0060-a-handler-kicks-a-declared-job-after-its-commit.md)): a new edge is shown and leaves
  access unchanged, because it reaches only a job of the same approved contract, which runs under its own declared
  actions; from a public procedure it widens with closer review, because anyone who calls it then decides when the job
  runs. A dropped edge narrows;
- **token purposes**: a new purpose with its lifetime, a longer lifetime and a change of its claims; a site that
  starts signing a purpose widens, because whoever holds such a token may call what verifies one;
- a mount's compatibility promise (`compatibility: 'backward'`), made or dropped, as a line that leaves access
  unchanged. A publication that breaks the promise is refused before classification, whoever approves it
  ([ADR-0012](0012-fabrika-app-runtime.md) §16);
- CSP extensions, `script-src`, `frame-src`, `style-src` and `font-src` included;
- each public variable a page reads from its browser config (an SPA mount's `browserConfig` list, a challenge's
  `siteKey`): shown by name, and a new one widens, because its value reaches anyone who opens a page;
- each site's declared reach;
- migrations: any new or changed file, and the database code they declare.

An application on framework 0.4, 0.5 or 0.6 is compared with the same rules after Control upcasts its artifact
([ADR-0062](0062-a-platform-release-serves-older-framework-releases.md)): its forms' admission and files, `then`,
file collections, their scan and their link-reachable rows keep the lines they had.

Each line carries one effect: it **widens** (it can grant access the baseline did not), it **narrows** (it can only
take access away), or it leaves access **unchanged** (it admits no one new and takes nothing away, but the approver
should know it). The console shows the three in their own sections. The rule has three outcomes:

- **`none`**, no line at all, passes.
- **`no-widening`**, lines that narrow or leave access unchanged and none that widens, passes. A removal is not
  always such a line (the two exceptions below).
- **`widening`**, everything else, waits for approval on a protected environment.

**A removed endpoint is classified by who answers its paths now.** The proxy selects the most specific endpoint
([ADR-0022](0022-the-proxy-is-the-only-enforcement-point.md)), so a literal endpoint can shadow a broader parameter
or wildcard endpoint, and removing it sends its paths to the broader one. A broader endpoint may also answer only some
of those paths or none, and an endpoint that merely overlaps them may have answered only its own paths all along. So
Control asks the canonical matcher (`planEndpoint`) about one path for each way the two tables tell the removed
endpoint's paths apart: which ones the removed endpoint answered before, and which endpoint answers each now. It
compares the callers each endpoint that now answers one admits with the callers the removed one admitted:

- no endpoint answers any: the paths become denied, and it narrows;
- some are denied and the rest reach endpoints that admit no caller more: it narrows, and the line says the rest are
  denied;
- every path reaches an endpoint, and each one admits exactly the removed endpoint's callers, with no body and no
  other origin the removed one refused: access is unchanged;
- each one admits no caller more: it narrows;
- otherwise it widens, and it waits like any other widening. A signed-in page falling through to a public SPA is
  the typical case.

"The same callers" is read narrowly. Two signed-in endpoints admit the same callers when they have the same kind, the
same requirement, the same caller kinds and the same delegation (`endpointDelegation`, which the proxy applies too). A requirement whose scope is read from a path parameter is never the same,
because a broader route reads it from another segment. A `link` caller is the same only on an endpoint of the same link
mount, because a link key reaches only its own mount. An anonymous health check or public SPA admits anyone, so a
signed-in endpoint after it admits fewer and another of those two kinds the same. A public procedure, a form and a
webhook turn callers away themselves, with a challenge, a bucket or a signature, so whatever takes over their paths
widens.

The line names who could open the paths before and who can now, so the approver does not have to know which
endpoint is public. A removed mount takes all its endpoints with it, so it is one line: its routes, grouped by where
they go now and by their effect, and the strongest effect among them. The mount also takes what is not a route: the
public variables its pages read (named on the line), a public procedure's or a form's admission, a link mount's
grants. So only an SPA mount
that served no public variable can leave access unchanged; any other removed mount narrows at least.

**A removed column read policy widens access.** Without its own read policy, a column falls back to the
table's read action. Removing a column's read policy is therefore a widening, and it waits. Removing a
whole table or a whole column stays a removal.

**What a table action grants.** The diff compares table policies by what their actions reach in the data layer:

- **A capability reads its own target.** A `Ref` of any action the table names — its read, insert, update and
  delete actions, and a column's own write action — reads its row and the rows of its subtree. Every column that
  declares a read action other than exactly the capability's is left out, of the statement and of the row type
  alike. A `Within` lists by the table's read action. So giving a table an action, or changing one, widens: that
  action's holders now read the rows it reaches.
- **An `app` endpoint's capability is its action held as a global grant.** It reads every row of an application
  table with the table's read action (one row with any action the table names), writes it with the operation's
  action, and reads every row of each dimension and child table whose read action is its own. The proxy admits only a
  global holder, so the form is a requirement change like any other: an endpoint that becomes `app: true`, or stops
  being one, widens. An application table's actions are compared as any table's are.
- **A column read action** (`columns: { c: { read } }`) is the only action that reads, filters and sorts that
  column. A new one narrows; a removed one widens (above).
- **A column write action** (`columns: { c: { write } }`) lets a capability of that action update exactly its
  columns through the target's `update`; the table's update action no longer updates them. A new or a changed
  column write action widens. A removed one narrows. A column moved from the table's update list under its own write
  action gives a removal line and a widening line.

**Steps off the paved road widen with closer review.** A site is keyed by its identity — the endpoint id, or the
job — and each effect of its declaration is compared on its own, so a handler body that moves with the same
declaration is unchanged. A new `sql` mode, a new `unscoped` table, `read` → `write` in either, a new connector,
a new link mount to issue (an endpoint's, or a job's `issues`, keyed by the job), a new `egress` origin, a new `binds`
webhook and a job that starts sending through the installation's mail transport each widen; a removal and `write` → `read` narrow. Database code is keyed by file, kind and
object: new code widens, code in a file whose text changed widens again (the diff cannot tell what changed in it),
and removed code narrows. A contract that leaves the staged kit, whose sites' reach is then no longer declared,
widens. A dimension that opts its member directory into labels (`directory: 'labels'`), so every `members.list`
holder there reads each member's email-derived label and every endpoint below it the label of a member it looks up,
widens too. Each of these widening lines carries
`review: 'closer'`: the approval page marks it "needs closer review",
because the approver must read the code behind the line, not only the line. A diff that cannot classify a change
also marks it for closer review. A closer-review line names its reason (below), so the mark is the result of a rule
the approver can read, never a label. On an unprotected environment the run publishes at once, with the same lines.

**An endpoint's input and output are compared by the values they admit.** A change that can only admit
fewer values narrows: an enum that loses a value, a lowered maximum, a raised minimum, an added pattern, a
field that becomes required or loses `null`. Every other change widens: a literal that becomes an enum, an
enum that gains a value, a removed or relaxed bound, a field that becomes optional or nullable, any new field,
a changed type, any change of a union (its first accepting option decides what projection keeps of a value). A
removed field narrows, except a required input field: an input that omits it was refused
before and is admitted now. The comparison descends into objects, arrays, optional and nullable values and
names the field, for example "Endpoint `api.deals.move` input `items[].stage` admits `won`". It attempts no
logical implication between schemas, so an equivalent rewrite of a schema widens too. The proxy applies no
schema, so the per-endpoint digest of [ADR-0022](0022-the-proxy-is-the-only-enforcement-point.md) does not
cover them; the snapshot digest and the contract digest do.

The diff is a pure function. It produces plain-language lines for the approver, for example "Role
`editor` gains `notes.delete`" or "New endpoint `api.notes.export` for editors".

**Each line is a structured fact, and its words are one rendering of it.** Beside its effect and its words, a line
carries:

- `rule`: a stable code of the comparison that produced it (`endpoint.public`, `admission.challenge`, `kick.public`,
  `table.action`, `migration.code`, …). One comparison, one code; a code never holds an application's identifier.
- `subject`: what the line is about: an endpoint (its id, method and path), a table and column, a role, a job, a mount,
  a migration file, or the application itself.
- `audience`, on an endpoint subject: who reaches it after the change, in the surface's terms (section 5): its reach,
  the link mount of a `link` caller, the roles or actions its requirement names. For a removed endpoint it is who
  reaches its paths now.
- `consequence`, when the line says what a call sets off: the job it starts, the table it writes.
- `reason`, on a closer-review line: `off-road` (a site's declared reach, database code, a contract that leaves the
  staged kit), `anyone-calls` (a public procedure, a workload action or a job kick that anyone without signing in
  sets off), `get-mutation`, `people` (who holds the application's roles, or labels that spell users' email addresses,
  become visible), or `unclassified`.

The diff builds each fact where it builds the line, so the words and the fact cannot drift apart, and nothing parses a
line. MCP's `deviations` and the CLI keep reading the words. Not built yet: [backlog 195](../backlog/195-the-approval-page-leads-with-who-gains-access.md).

**The environment's cross-origin list is not part of the change.** Which pages on other origins may call an endpoint
the contract opens to them (`admission.origins`) is a fact of the environment, not of the contract
([ADR-0022](0022-the-proxy-is-the-only-enforcement-point.md) "Cross-origin endpoints"). Whoever holds `app.manage` on
the application sets it, and that includes the builder key the local agent holds
([ADR-0042](0042-connect-local-builders-through-human-consent.md)), which carries `app.manage` on every environment of its application. Control
republishes the namespace proxy at once, and no approval covers it, on a protected environment too. The list is left
outside approval because it grants no authority: a request from a listed origin is bearer-only (ADR-0022 rule 3,
no `Allow-Credentials`, the session cookie never read), so it reaches only what the `px_` key it carries already
reaches from any server. Listing an origin lets a page in a browser use a key it already has; it does not let the page
act as the person who visits it. What does widen is the contract opening an endpoint to the list at all, or a removed
endpoint's paths falling to one that is open to it, and that line waits like any other widening. While a run waits for
a decision, the approval page names the list as it stands beside each such line. A decided approval names none: the list may have changed since, and nothing records it with the
decision. The environment page shows the list too.

### 4. Only production is protected by default

Each environment has a `protected` flag, a column of Control's `app_envs`. `prod` is protected by
default; every other environment is not. Changing the flag requires `access.approve` from a human user
principal, the same rule as approving (section 5). Control's audit log records every change.

The flag changes through `apps.environments.protect`, and its only caller is the console: the application's
page lists each environment under "Access approvals", with the switch for a caller holding `access.approve`
there. No CLI verb or MCP tool changes it, because a key or an agent must not unprotect an environment. Turning
approvals off asks for a confirmation first. A typical case for it: a team whose every merge to the trigger
branch is already reviewed on GitHub. The change waits while a run of the environment is `running` (409) and
applies from the next classification. It decides no parked run: a run in `awaiting_approval` keeps waiting
until a person approves, rejects or cancels it, and once approved it classifies again under the new flag. A
newer deploy does not wait for it.

The flag outlives its environment. Deleting the environment or the application writes the flag and
both counters, `generation` advanced, to `app_env_protection`. Nothing deletes that row. A recreated
environment starts from it, else from the default. Deleting a protected environment, or an application
with one, takes the same human with `access.approve`.

Unprotected environments do not wait. Every environment with `protected = true` requires approval
for a widening, whatever its name or role. Staging and MCP authoring targets are unprotected by
default, so a change applies there at once. When the same commit is deployed to a protected
environment, Control classifies it again against that environment's active snapshot.

Staging must not hold production data. This is a rule for operators; the platform does not enforce it.

### 5. A human user approves, with `access.approve`

A run whose change waits enters the state `awaiting_approval`. Control serves `approvals.list`,
`approvals.get` and `approvals.complete` behind a new action, **`access.approve`**. The action is
outside the `deploy.*` wildcard, so the `operator` role does not grant it.

- **Only a user principal can approve.** A service principal, the builder key and any OAuth or MCP
  token are refused, even when they carry `access.approve`.
- **The approval happens in the dashboard**, with a same-origin request. The `access.approve` check and
  the user-principal check are authorization; the proxy's `Sec-Fetch-Site` check is admission, in the
  vocabulary of ADR-0022.
- **The approval records the candidate digest and the baseline digest.** It approves one change against
  one baseline.
- **Runs record their actor**, including runs created through MCP. MCP's `get_deployment` reports a
  parked run with the approval link, and names the run's closer-review lines (`deviations`), parked or not.
- **The environment page lists the published snapshot's deviations**, protected or not, so the steps off the road
  an environment runs with stay visible after their approval. Control groups them by site and migration
  (`AppEnvDto.deviationSubjects`). The page is an inventory of published access, so it carries no closer-review mark:
  that mark belongs to the access change of a deploy.
- **The environment page lists the published snapshot's surface**: every endpoint under its most exposed caller
  (anyone, share links, other apps, machines, signed-in people), in the approval's words, with what else opens it —
  another origin, a file it answers, its body limit, its rate buckets and challenge, a webhook's signature
  (`AppEnvDto.surface`, `snapshotSurface`). It reads only the published snapshot, so it shows what the proxy serves.

**Invariant: only a human user principal approves an access change.** No credential that an agent or a
workload can hold completes an approval.

### 6. A rollback is a new deploy

A rollback deploys an older commit as a new run. Control classifies it like any other run, against the
environment's active snapshot. Publishing an older run's snapshot again is not a rollback path.

### 7. The approval page leads with who gains access

A deploy of an agent-authored change can carry hundreds of lines, most of them harmless. The approver must see in one
glance who gains access to what, and the few lines that decide it. The page is built from the facts of section 3,
never from the words of a line:

- **Impact first.** The head counts the changed endpoints per caller group and the new or changed migrations, for
  example "5 endpoints anyone calls, 2 endpoints a share link of `student` reaches".
- **Grouped by caller.** The facts of an endpoint fall under its audience, in the order and words of the environment
  page's surface: anyone, a share link per link mount, another application, machines, and signed-in people per
  requirement. Facts on any other subject form a second part, data and runtime, grouped by subject kind: tables,
  roles, jobs, migrations, the application. A group is named by the contract's identifiers (a role name, a link mount
  name); the contract declares no display label for them.
- **Rank is derived, there is no severity field.** Groups and facts are ordered by effect and review (a widening with
  closer review, a widening, a neutral line, a narrowing), then by reach, anyone first. Nothing else enters the rank,
  so it cannot disagree with the classification.
- **A warning says why.** A closer-review fact shows one fixed sentence for its reason; `anyone-calls` on a kick, for
  example, reads "anyone on the internet decides when job `mailing` runs".
- **Protection is shown, not asked for.** An endpoint anyone calls shows its effective admission from the candidate
  snapshot beside it: buckets, challenge, body limit and time limit. The page never asks the approver to verify
  something the snapshot states. Whether a bot check holds is read from the endpoint's challenge, never from a browser
  config variable: a removed `siteKey` variable is a line about what a page reads, and a dropped challenge is its own
  widening line on the endpoint. The environment's cross-origin list is named as section 3 says, and nothing presents
  it as protection.
- **Similar facts fold, widenings stay in view.** Facts of one rule and one effect on many subjects fold into one row
  ("a body limit of 64 KiB on 40 endpoints"). A group or row the page collapses by default holds no widening fact, so
  every widening is visible without expanding anything.
- **Grouping decides nothing.** Whether the run waits is `classifyAccess`'s outcome alone. The grouping is a pure
  function over the facts, beside the DTO in `@fabrika/control-contract`; a test holds that it keeps every fact, and
  that the widenings it shows by default are exactly the widenings of the classification.
- **The lines stay.** The three effect sections of section 3, with search and a filter, are one step away. They are
  the same facts, unordered.
- **A decided run says where it stands.** Approval and publication are two steps (section 2): an approved run is
  queued again and classified once more before it publishes. The page shows which of these holds: approved and waiting
  to run; published; or the approval lapsed, because the environment published another change first and the change
  still widens against it, so the run waits for a new approval. A refused or cancelled run says so.

## Consequences

- An agent can no longer widen production access silently. A widening on `prod` waits until a human
  reads the plain-language lines and approves.
- A removal deploys without a prompt, unless the endpoints that answer its paths now admit a caller the removed one
  did not, or it removes a column read policy. Moving a page's paths to another page for the same callers, the usual
  refactor, does not prompt. A change of handler code that leaves the shell and the migrations as they were deploys without a prompt too. A
  change that declares a new step off the road, or widens one, waits like any other widening. Unprotected
  environments, including staging and MCP authoring targets by default, do not wait.
- A deviation is not a refusal. The approver sees each one marked for closer review; what an admitted statement can
  then do in Postgres is bounded by the application's role family
  ([ADR-0017](0017-service-owned-postgres-migrations.md)), not by the approval and not by the classifiers' name
  rules, which are defense in depth.
- The first deploy to a protected environment always waits: against the empty snapshot, every item is
  an addition.
- An agent cannot unprotect an environment to avoid the prompt: the flag change needs the same human
  approval.
- Every path that touches published access goes through one function and one compare-and-swap. A new
  write path must use `approvedSnapshot(app, env)`; a path that reads the provider artifact for access
  data is a bug.
- The diff is conservative. It does not recognize a harmless addition and shows no head counts, so
  approvals on `prod` may be frequent. Approval fatigue is a real risk; the number of prompts per
  deploy must be measured. For a removal it takes the smallest step towards a reachability classifier: it compares
  who the endpoints that answer the removed paths admit with who the removed one admitted, field by field over every
  field of an endpoint row and its delegation. The comparison is total over `EndpointRow`, so a field the proxy
  comes to apply fails Control's typecheck until the comparison decides it; it is never waved through. Additions are
  still all widenings.
- Rolling Control back below the version that wrote three effects breaks reading every run that version classified
  (the older schema is strict and knows only `widens`): the approval page, the approvals list and MCP's
  `get_deployment` fail for those runs. Before 1.0 that is accepted; no dual format is written. The same holds for
  rolling back below the version that writes structured facts (section 3).
- A run classified before lines carried facts keeps its stored lines without `rule`, `subject` or `audience`. The
  approval page shows them in their effect sections as unsorted lines and builds no groups for that run; a parked run
  that is classified again gets facts. No migration rewrites a stored classification.
- Every comparison in `diff.ts` must emit its rule, subject and audience beside its words. A comparison added without
  them is a type error, not an unsorted line.
- The approval proves a signed-in user with `access.approve`, not a physical human. An agent that drives
  the approver's own signed-in browser can approve. The skill forbids it; WebAuthn on
  `approvals.complete` is the next step.
- A rollback that restores removed access waits for approval like any other widening.
- Approval exists only on protected environments. Staging is unprotected by default, so it must hold
  no production data.
- Control needs the static reader on both runtimes, and the dashboard needs an approval page.

## Alternatives considered

- **Rely on pull-request review.** Rejected: the change is visible only in the pull request, and the
  threat is a person who does not read the diff.
- **Keep reading access data from the provider artifact or the runner outcome.** Rejected: both are a
  self-report of the build the agent controls, and the artifact is one mutable value.
- **Store approvals in a separate record beside the run.** Rejected: a snapshot on the run keeps the
  candidate, the baseline and the approval together, and `published_run_id` points at one row.
- **Approve every deploy, or every change.** Rejected: a prompt for a code-only change teaches people
  to approve without reading.
- **Refuse every step off the paved road.** Rejected: an agent that is refused loads every row, or works around the
  framework where nothing declares it. A declared step is allowed, bound to its site at runtime, and shown.
- **Detect steps off the road in handler code.** Rejected: Control would have to read and parse handler modules,
  and a syntactic detector is evaded by destructuring, helper modules and `ctx[k]`. The declaration in the shell is
  what the runtime enforces, so it is what the snapshot holds.
- **Put the checker's structure hints into the snapshot.** Rejected: a file in the wrong layer reaches no data, and
  every such hint would cost an approval.
- **Recognize harmless additions automatically.** Deferred: it needs a reachability classifier. v1
  gives it up and treats every addition as a widening.
- **Keep every removal that uncovers an endpoint a widening, and only improve its wording.** Rejected: the line reads
  better, but the run still parks on a change that admits no one new, such as a public page whose paths move to
  another public page. Only reclassifying it removes the prompt, and a prompt that is always safe to approve is the
  fatigue this decision warns about.
- **Classify a removal by comparing the digests of the rows.** Rejected: the digest covers the path, which differs by
  definition, and it cannot say that one row admits fewer callers than another.
- **Gate the environment's cross-origin list by approval.** Rejected: the list grants no authority (bearer only, see
  section 3), it is not part of the contract the approval binds, and a registry write has no run to park. The
  approval page names it beside each line that opens an endpoint to it.
- **Give each line a severity score.** Rejected: a second judgement beside the effect, set by hand per rule, which can
  disagree with the classification. The page derives its order from effect, review and reach (section 7).
- **Group the lines in the console by parsing their words.** Rejected: the words are prose and change with wording
  fixes; the diff knows the structure when it writes the line.
- **Name caller groups by labels the contract declares ("Staff", "Student").** Deferred: it changes the framework API.
  Until then a group carries the role or mount identifier.
- **Collapse the data and runtime part by default.** Rejected: a new table action widens, and a collapsed group would
  hide it. Only a group without a widening collapses.
- **Warn when a challenge's site key leaves the browser config.** Rejected: the variable says what a page reads, not
  what the server checks. A dropped challenge is its own line on the endpoint.
- **Protect every environment by default.** Rejected: staging and MCP authoring targets must apply at
  once by default, or the authoring loop stalls. A human can still protect any environment.
- **Let the deploy permission approve.** Rejected: every operator holds `deploy.*`, and the builder key
  holds `deploy.trigger`.
- **Let a service principal, the builder key or an MCP token approve.** Rejected: the agent holds those
  credentials, so it could approve its own widening.
- **Roll back by republishing an older run's snapshot.** Rejected: that snapshot was approved against
  a different baseline. A new deploy is classified against the current one.
