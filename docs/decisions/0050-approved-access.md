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
change on a protected environment that needs closer review wait for a human.** A change that needs closer review
is one with a closer-review line (section 3): a step off the paved road, something anyone sets off without
signing in, a mutation served on `GET`, people becoming visible, a file collection adopted or released, a terminal
naming who is signed in, or a migration statement not known to keep every stored value. Any other change, a plain widening included,
publishes at once with its lines recorded: the people who deploy ordinary work are often not the ones who can read
an access diff, and a prompt on every new endpoint teaches them to approve without reading.

Built in work unit B6 (`packages/control/src/approval/`). Details the sections below leave open:

- The migration checksum is the SHA-256 of the file's text, the checksum the application's ledger records;
  every file under `db/migrations/` is listed.
- The snapshot digest covers the canonical contract (each site's declared reach included) and the migration list,
  and the database code and the SQL statements only when there are some; not the checker version nor a statement's
  line. It keeps the trailing `null` that once
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
  `approvedSnapshot` reads it as the empty baseline, so the application's first contract is classified as a
  whole, and waits on a protected environment when it holds a closer-review line. The empty unpublished baseline stays valid.
  `runs.pending_access_json` is no longer read or written; a later migration drops it.
- The published snapshot is stored on `app_envs.published_snapshot_json`, written by the same
  compare-and-swap as `published_run_id`.
- On Cloudflare a run's snapshot and its classification are objects in the run-log bucket, named by the SHA-256 of
  their text (`access/<hex>.json`), and `runs.snapshot_json` and `runs.classification_json` hold `sha256:<hex>`: a D1
  row holds at most 2,000,000 bytes, and a large application's snapshot and classification together exceed it. A read
  checks the text against the digest. On Postgres the row holds the text. A row written before the objects keeps its
  text and reads as it did. The publication on `app_envs` stays text, bounded by `STORED_SNAPSHOT_BYTES`. Every deploy
  reads the last succeeded run's snapshot, and a missing object fails it, so nothing may expire or delete `access/` (a
  lifecycle rule may expire `runs/`). Unlike mail content (ADR-0019), a snapshot holds no secret, the bucket is bound on
  every Cloudflare Control, and the digest proves its text, so it needs no bucket of its own.
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
first, so the contract reader never fetches, parses or runs a module that only a handler imports. It classifies the
migration files with the classifier the runner applies them with ([ADR-0017](0017-service-owned-postgres-migrations.md)).
When a site declares `sql`, it also reads the SQL statements of every server module, as text (below). The run stores
the result as its **snapshot**:

- the parsed contract and table policies, with each site's **declared reach** (`ContractArtifact.declared`): the
  `sql` mode, the `unscoped` tables and their modes, the `connect` imports, the `issues` mount, the `kicks` jobs, the
  `binds` webhook, the `signs` purposes, the `egress` origins (or a job's `'public'`) and a public procedure's workload `actions` of each
  endpoint, job and webhook that declares any;
- the migration list with checksums;
- the **database code** the migrations declare (`databaseCode`): each function, procedure, trigger, view, rule,
  policy, `DO` block and expression that calls database code, by file, kind and object;
- the **SQL statements** (`sqlStatements`), once a site declares `sql`: each tagged template of a server module under
  `src/` whose tag may be `ctx.sql` (a member ending in `.sql`, or an identifier, called or not), by file, line and
  the SHA-256 of its text. A declaration says only that a site runs raw SQL, and since `ctx.sql` does not check where a
  scope fragment stands ([ADR-0012](0012-fabrika-app-runtime.md)), the statement is the only record of what it reads.
  Control reads these modules as text and parses them; it never runs them. The reading is syntactic, so it errs
  towards a template too many: a statement through a tag held in an object member other than `.sql` is not seen;
- the **file adoptions** the migrations make (`fileAdoptions`, [ADR-0061](0061-a-file-is-a-value-in-a-table-column.md)):
  each `INSERT … SELECT` that copies a file collection's files into a table, and each release of a collection. They
  follow from the migration files, so the digest does not cover them beyond the files' checksums. The diff compares
  only a candidate's, so the run's snapshot keeps them and the environment's publication leaves them out;
- the checker version;
- the baseline the candidate was compared with;
- the approval, when one was needed.

The declared reach, the SQL statements and the database code are the snapshot's **deviations**: the steps off the
paved road. Nothing else of the handler code reaches the snapshot; the checker's structure hints stay checker output.

A migration file the classifier refuses (an escape from the schema, the transaction or the platform) fails the
read, as the runner would refuse it, except a file the environment's published snapshot holds with the same
checksum: the runner skips an applied file, so a stricter classifier cannot lock an application out. A migration file
the environment's last succeeded run deployed fails the read when its checksum changed, one line per file, as every
runner refuses an applied file that changed ([ADR-0017](0017-service-owned-postgres-migrations.md)); it is compared
with that run's stored snapshot, not the published one, because a publication precedes the provider. The read is
bounded: 512 shell files, 16 Mi characters of migration text, which the classifier reads at once, and 1000 server
modules with 16 Mi characters of text for the SQL statements.

Uploads carry no proxy table and no IAM schema. A snapshot comes only from the commit.

### 2. Publication is a compare-and-swap on the environment

`app_envs` gains `published_run_id`, `generation` and `protection_revision`. The published run's
snapshot is the environment's **active snapshot**.

One function, `approvedSnapshot(app, env)`, feeds every path that publishes a proxy table or
reconciles IAM:

- the deploy;
- `apps.environments.put` and `delete`, and `apps.delete`;
- `namespaces.reconcile` and the namespace jobs;
- Control's IAM schema write after a run succeeds: the deploy, a provider reconcile and a cancellation (ADR-0011).

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
from anything other than `approvedSnapshot(app, env)`, or, for a workspace sandbox of a `dev` environment, the
snapshot that workspace's own bootstrap run published through it.

A `dev` environment publishes per workspace ([ADR-0049](0049-author-applications-through-mcp-in-control.md) rule 10).
A workspace's bootstrap run classifies against the snapshot its workspace last published (the environment's active
snapshot when it has none), publishes through the same compare-and-swap on the environment, and is recorded as its
workspace's published run (`dev_sandboxes.published_run_id`). The namespace proxy's entry for a workspace sandbox is
compiled from that workspace's published run; IAM follows the environment's active snapshot, which is the most
recently bootstrapped workspace's.

### 3. Classification is a conservative diff

Control compares the normalized access data of the candidate snapshot with the environment's active
snapshot. An environment with no published run has the empty snapshot as its baseline. The comparison
covers:

- endpoint callers, access forms (the `app` form named as a global grant, each capability of `capabilities` by its
  name and form), input domains and output shapes (a file output by its kind, a `redirect()` by where it may send a
  caller), and each endpoint's HTTP shape. An `anyOf` requirement is compared by action: an action the list gains
  widens, one it loses narrows; `action` → `anyOf` widens by the actions added;
- containment, roles and their actions, membership rules;
- **the member directory an endpoint may read** (`ctx.members`, recorded in the artifact's `directories`): the
  runtime grants it by the access form alone, so its line says what the handler can do ("can list the members of
  `team`"), not what it does. The approved endpoints of the same action that reach that directory at least as far, the
  endpoint's own approved row among them, are its peers. A caller kind the endpoint admits that no peer admits widens,
  with closer review where the dimension shows labels: a new reach with no peer, and an endpoint that keeps its reach but
  gains a caller kind, which the line names ("for `machine` callers too"). When the peers admit every caller kind the
  endpoint admits, a new reach leaves access unchanged and names a peer, one the change keeps where there is one ("as the
  approved `api.get` already can"; "could" when the change removes it): IAM answers a directory by the action held live
  on the dimension's value, so no caller learns of a member it could not learn of before. The endpoint's own lines (a
  new endpoint, a changed requirement) still widen. A removed reach narrows;
- table and column policies, with the actions each column is read and written with; a new application table
  (`scope: { app }`) is shown with its reason and every action. A table operation that names a list of actions is
  compared by action: an action the list gains widens, one it loses narrows. A read that becomes `'any'` widens to
  every `app` endpoint, job and webhook, and one that leaves it for a list widens too, because the list may admit a
  public procedure or a scoped endpoint that `'any'` refused;
- anonymous kinds (a new public SPA, or an SPA that becomes public, widens) and link mounts;
- **public procedures**: a new one, or an endpoint that becomes public, widens with closer review ("for anyone,
  without signing in"), and so does each workload action it gains ("runs as its own workload with `<action>`, for
  anyone who calls it"); a lost action narrows. These actions are no step off the road, so the environment's deviation
  list does not show them ([ADR-0063](0063-a-public-procedure-runs-as-its-own-workload.md));
- **each procedure's admission and limits, by their effective values**: its buckets, its challenge, its body limit,
  how long it waits for that body (the deadline the runtime derives from the limit) and its time limit, which starts
  after the last byte, derived ones included, on every new procedure and on every procedure the baseline records no rules
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
- migrations: any new or changed file, and the database code they declare;
- **SQL statements**, matched by file and text: a new, changed or removed one needs closer review (`off-road`), since a
  removed one may have been the check that kept a row out. Re-indenting a statement or moving it within its file is no
  change. A baseline published before Control read statements shows none, and the deploy that publishes over it
  records them;
- **file adoptions** in a new or changed migration file: an adoption widens with closer review, because whoever the
  table's policy lets read a row now reads its file, and a release narrows with closer review, because it drops the
  collection with every file no column adopted. A file the baseline holds unchanged has run already, and adds no line.

An application on framework 0.4, 0.5 or 0.6 is compared with the same rules after Control upcasts its artifact
([ADR-0062](0062-a-platform-release-serves-older-framework-releases.md)): its forms' admission and files, `then`,
file collections, their scan and their link-reachable rows keep the lines they had.

Each line carries one effect: it **widens** (it can grant access the baseline did not), it **narrows** (it can only
take access away), or it leaves access **unchanged** (it admits no one new and takes nothing away, but the approver
should know it). The console shows the three in their own sections. The rule has three outcomes:

- **`none`**, no line at all, passes.
- **`no-widening`**, lines that narrow or leave access unchanged and none that widens, passes. A removal is not
  always such a line (the two exceptions below).
- **`widening`**, everything else.

The outcome does not decide whether a run waits. **On a protected environment a run waits when a line needs closer
review** (`waitsForApproval`, `@fabrika/control-contract`, the one predicate Control and the console share), whatever
the outcome; a plain widening publishes at once and keeps its lines on the run.

**A migration statement not known to keep every stored value waits.** Before this rule every new migration waited on
a protected environment, so the data rule fails closed: a list of destructive forms is never complete. The runner's
classifier records every top-level statement of a migration file that it cannot show keeps every stored value in the
snapshot's `dataLoss` (by file, statement, object and line). A statement keeps every stored value, and records
nothing, when it is:

- `CREATE …`: a new table, index or enum holds nothing yet, and database code is a closer-review line of its own; a
  `DO` block is one too;
- `ALTER TABLE … ADD [COLUMN]`, `ADD CONSTRAINT` and `DROP CONSTRAINT`, and `ALTER COLUMN … SET|DROP DEFAULT` and
  `SET|DROP NOT NULL`;
- `COMMENT ON`, and `ALTER TYPE … ADD VALUE`;
- a `DROP` without `CASCADE` of an index, a type, a domain, database code, a view or a materialized view: Postgres
  refuses it while a column, a default or a constraint depends on it;
- a plain `INSERT … VALUES|SELECT`, with no conflict clause or `ON CONFLICT DO NOTHING`, no SQLite `OR <action>`, and
  no read of a view the migration set declares;
- an `UPDATE` or upsert of a table an earlier `CREATE TABLE` of the same file created, and an `UPDATE` or
  `ALTER COLUMN … TYPE` of columns an earlier `ADD COLUMN` of the same file added (not with `IF NOT EXISTS`), while
  no rename statement came before it in the file and it reads no declared view;
- the framework's `fabrika_files_copy_legacy` call, which inserts with `ON CONFLICT DO NOTHING`, and its
  `fabrika_files_release` call, a closer-review adoption line of its own.

Every other statement records a line, worded when the classifier knows what it does:

- deletes data: `DROP TABLE`, `ALTER TABLE … DROP [COLUMN]`, `TRUNCATE` (`TRUNCATE … CASCADE` names the tables that
  reference it too), `DELETE`, and every `DROP … CASCADE`, which also drops what depends on the object: dropping a type
  or a domain drops each column of it, with its values;
- overwrites data: `UPDATE` (`UPDATE OR REPLACE` may also delete the rows it conflicts with), `INSERT … ON CONFLICT …
  DO UPDATE`, and `ALTER COLUMN … TYPE`, with or without `USING`, since an implicit cast can round or cut a value;
- may change data: a call of a function the migration set declares, once per function and statement (a built-in
  records nothing), and, generically, "may change data: `<the statement's first keywords>` at line N" for anything
  else. That covers every rename (`ALTER TABLE|INDEX … RENAME`, `RENAME COLUMN`, `ALTER TYPE … RENAME VALUE`, a rename of
  database code), `VALIDATE CONSTRAINT`, which runs the check on every row and may call declared code through it, an
  identity change, SQLite's `INSERT OR <action>`, an `INSERT` that reads a declared view, which may call declared code,
  a `DROP` of a sequence or an extension, and every form not named above. A rename also ends the same-file exceptions
  for the rest of the file, since another table or column may then carry a created name.

A conflict clause on a constraint (SQLite's `ON CONFLICT REPLACE` in `CREATE TABLE` or `ALTER TABLE`) is refused: it
turns every later plain `INSERT` into a delete of the row it meets.

For a new or changed file each is a line that leaves access unchanged, rule `migration.deletes-data`, reason
`deletes-data`, worded by what it does: "Migration `<file>` deletes data: drops table `audit` with every row",
"… overwrites data: overwrites `notes.title` in every row it matches", "… may change data: calls database code
`purge`". It waits for a person on a protected environment like any other closer-review line, separate from the line
that adds the migration. Like the file adoptions, `dataLoss` follows from the checksummed files, so it is not part of
the digest, and a publication leaves it out; the diff reads it only from a candidate. A statement inside a function,
trigger or `DO` body is not recorded: that code is a closer-review line of its own.

What stays uncovered: declared code a migration reaches only through a trigger or a rule an earlier migration
declared and a person approved. A plain `INSERT` into such a table runs it with no line of its own. A `DELETE` that
cascades through a foreign key's `ON DELETE CASCADE` names only its own table.

**The platform backs the data up before such a migration runs.** The files to back up for are the candidate's with
a `dataLoss` statement of any kind, deleting, overwriting or not known to keep every value, and that the environment's last succeeded run did not deploy as they are now: not the publication, which
precedes the provider and survives a failed run, so a retry after a failed deploy is backed up again. On Zerops,
Control hands them to the provider as `backupBeforeMigrations`, and the deploy backs up the application's database and
waits until the backup is listed before a version that runs them can start; a backup that fails or does not finish
fails the run with nothing deployed ([`zerops-platform.md`](../reference/zerops-platform.md)). On Cloudflare the
migration phase takes the backup ([ADR-0070](0070-data-protection-of-an-application-environment-on-cloudflare.md) §8),
so such a migration deploys only once the version running holds the backup barrier; without it Control refuses the run
before any deploy and says what to do: give the environment a domain, raise the framework pin, or deploy once without
that migration. A dev environment's database is its workspace sandbox's, and nothing backs it up. A missing record
never reads as "nothing changes data": a run parked by a release before the classifier stored no `dataLoss`, so when it
resumes Control classifies its commit again, and when the commit no longer reads, every migration file the last
succeeded run did not hold counts. A side restore's deploys redeploy what runs, under the restore's lease and with the
object frozen or pointed away, where no backup can run
([ADR-0070](0070-data-protection-of-an-application-environment-on-cloudflare.md) §9). One that would bring such a file
anyway (the application's directory changed since) is refused, and the restore fails before anything is frozen. Which
run is a restore's deploy comes from the restore's record, as for the start check below, so the refusal holds also for
one an approval queued again.

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
- otherwise it widens. A signed-in page falling through to a public SPA is
  the typical case.

"The same callers" is read narrowly. Two signed-in endpoints admit the same callers when they have the same kind, the
same requirement, the same caller kinds and the same delegation (`endpointDelegation`, which the proxy applies too). A requirement whose scope is read from a path parameter is never the same,
because a broader route reads it from another segment. After an `anyOf` endpoint, one whose requirement is the `app` form of a listed
action, or an `anyOf` whose list the removed one's contains, admits no caller more. A `link` caller is the same only on an endpoint of the same link
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
  being one, widens. An application table's actions are compared as any table's are. An `anyOf` endpoint's capability
  holds the listed actions the caller holds globally and reaches the union of what each of them reaches alone (a
  column of its own read action only where that action reads every row or is the only one reading; an update only
  under an action that writes every column it changes), so its list is what the diff compares.
- **A column read action** (`columns: { c: { read } }`, one action or a list) is the only action, or the listed
  actions, that read, filter and sort that column. A new one narrows; a removed one widens (above); each action a list
  gains widens and each it loses narrows.
- **A column write action** (`columns: { c: { write } }`, one action or a list) lets a capability of that action, or of
  any listed one, update exactly its columns through the target's `update`; a table update action updates them only
  when it is listed, beside its update list. A new or a changed column write action widens. A removed one narrows;
  each action a list gains widens and each it loses narrows. A column moved from the table's update list under its own
  write action gives a removal line and a widening line.

**Steps off the paved road widen with closer review.** A site is keyed by its identity — the endpoint id, or the
job — and each effect of its declaration is compared on its own, so a handler body that moves with the same
declaration is unchanged. A new `sql` mode, a new `unscoped` table, `read` → `write` in either, a new connector,
a new link mount to issue (an endpoint's, or a job's `issues`, keyed by the job), a new `egress` origin, a job's
`egress: 'public'` ([ADR-0075](0075-a-cron-job-may-reach-the-public-web.md)), a new `binds`
webhook and a job that starts sending through the installation's mail transport each widen; a removal and `write` → `read` narrow. Database code is keyed by file, kind and
object: new code widens, code in a file whose text changed widens again (the diff cannot tell what changed in it),
and removed code narrows. A contract that leaves the staged kit, whose sites' reach is then no longer declared,
widens. A dimension that opts its member directory into labels (`directory: 'labels'`), so every `members.list`
holder there reads each member's email-derived label and every endpoint below it the label of a member it looks up,
widens too. Each of these widening lines carries
`review: 'closer'`: the approval page marks it "needs closer review",
because the approver must read the code behind the line, not only the line. The diff leaves no change unclassified:
a change it has no finer rule for (`valueChange`, a union, an equivalent rewrite of a schema) widens, without a
closer-review mark, so it alone does not make a run wait. A closer-review line names its reason (below), so the mark is the result of a rule
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

- `rule`: a stable code of the comparison that produced it (`endpoint.added`, `endpoint.body-limit`, `procedure.challenge`,
  `reach.kicks`, `table.read`, `migration.database-code`, …). One comparison, one code; a code never holds an
  application's identifier.
- `subject`: what the line is about: an endpoint (its id, method and path), a mount, a dimension, an action, a role, a
  table, a file collection or kind, a job, an export or import, a token purpose, a CSP directive, a migration file, or
  the application itself.
- `audience`, on an endpoint subject: who reaches it, in the surface's terms (section 5): its reach, the link mount of a
  `link` reach, and its requirement in words. It is read from the candidate's row, or from the baseline's for a removed
  endpoint. A removal that widens (an endpoint, or a mount, whose paths now reach an endpoint that admits more) takes
  the audience of the most exposed endpoint that answers them now, so its line stands with whoever gains access; that
  is the one line about a mount that has an audience.
- `consequence`, when the line says what a call sets off: the job it starts.
- `reason`, on a closer-review line: `off-road` (a site's declared reach, database code, a contract that leaves the
  staged kit), `anyone-calls` (a public procedure, a workload action or a job kick that anyone without signing in
  sets off), `get-mutation`, `people` (who holds the application's roles, or labels that spell users' email addresses,
  become visible), or `adoption` (a file collection adopted into a table, or released).

The diff builds each fact where it builds the line, so the words and the fact cannot drift apart, and nothing parses a
line. A line gets its rule where a comparison composes it and its subject where it is placed, and only a line that has
both is placed, so a comparison without them does not typecheck. The audience follows from the subject. MCP's
`deviations` and the CLI keep reading the words.

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
endpoint's paths falling to one that is open to it; such a line widens, and waits when the change needs closer review. While a run waits for
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
for a change that needs closer review, whatever its name or role. Staging is unprotected by default, so a change applies
there at once. When the same commit is deployed to a protected environment, Control classifies it again against that
environment's active snapshot.

The flag also limits who deploys. Only a person starts a manual run of a protected environment: a user principal
without OAuth or link claims (`isPerson`, `src/approval/human.ts`), which in practice is a person in the console. No
flow issues a person a bearer of their own: `fabrika control` and the builder's device flow run with service keys. A
service principal, the builder key ([ADR-0042](0042-connect-local-builders-through-human-consent.md)), an IAM service
key and an MCP agent are refused with a 403 that names the cause; Control cannot tell the builder key from any other
service key, so all of them are refused. A push or a poll is unaffected: a person pushed.

A manual run of a protected environment names a full ref (`refs/heads/…`, `refs/tags/…`) or a 40-character commit
SHA; any other spelling is refused with a 400 that names the accepted forms. A workspace ref (`refs/heads/fabrika/…`)
is refused there whoever asks: a workspace reaches a protected environment only after a merge into its trigger ref
([ADR-0049](0049-author-applications-through-mcp-in-control.md) rule 7). The limit: a SHA or a tag is not traced back
to a workspace, so a person can still deploy a workspace head by its SHA. Only a person gets that far, and the
console's own redeploy of a run names its commit by SHA.

Control checks the run again when it starts, against the environment as it is then, because the flag may have been
set after the run was queued: a manual run whose actor is not a person (`user:`), or whose ref is refused as above,
fails with the same message in its run log and deploys nothing. A restore's own deploy is exempt: it redeploys the
commit the environment last ran ([ADR-0070](0070-data-protection-of-an-application-environment-on-cloudflare.md) §9).
The exemption comes from the restore's record, which names the run before the run exists, so it holds also for a
restore's deploy that waited for approval and was queued again once a person approved it.

A key cannot redirect what a deploy of a protected environment runs either. `apps.environments.put` that names a
different trigger ref for one, or creates one with a trigger ref (a new `prod`, or one whose protection was kept), takes
a person (403), as does `apps.register` of an app whose environment starts protected with a trigger ref. So does
`apps.update` of an app with a protected environment that changes any field it takes: `repoUrl`, the GitHub source
binding, `defaultBranch`, `workerDir`, `buildCmd` or `configPath`. Clearing the trigger ref stops push deploys and stays
open to a key, as does a `null` field, which keeps the stored value. `apps.update` writes only the fields whose value
differs from what it read, so a value a key sends again never undoes a change made since; a key's write applies only
while no environment of the app is protected, judged in the write's own statement, so a protection that lands after the
check still refuses it.

These are authorization checks in Control's use cases, after `deploy.trigger`, so a caller without it still gets the
404 of an absent environment. For the same reason an MCP authoring target is never protected:
`apps.environments.put` refuses `authoring: true` on a protected environment, and `apps.environments.protect`
refuses an authoring target (409).

Staging must not hold production data. This is a rule for operators; the platform does not enforce it.

A `dev` environment ([ADR-0049](0049-author-applications-through-mcp-in-control.md)) is never protected and cannot be
marked protected: `apps.environments.protect` refuses it (409), and an environment that was protected before it was
deleted cannot come back as one. Its widenings apply at once, like staging's, and the same operator rule on production
data binds it.

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
- **The environment page and the approval detail read the access by role**: each role, where it is granted, who
  assigns it and which new values grant it to their creator, the actions it holds directly or through a relation (with
  the rows that confer it), and per action the endpoints a person or a script calls with it, the tables it reaches with
  where their rows lie and every other path to them (a path column, a reveal, an access view, a condition), the stored
  files, and the people and share links it manages; the endpoints any member reaches are listed once
  (`AppEnvDto.accessMap`, `ApprovalDto.accessMap`, `snapshotAccessMap`). The approval detail shows the candidate's, so an
  approver reads the whole access the run would publish to people and scripts beside the change.

**Invariant: only a human user principal approves an access change.** No credential that an agent or a
workload can hold completes an approval.

### 6. A rollback is a new deploy

A rollback deploys an older commit as a new run. Control classifies it like any other run, against the
environment's active snapshot. Publishing an older run's snapshot again is not a rollback path.

An older run therefore never deploys after a newer run of the same environment and lane succeeded. A run has no lane,
except a `dev` bootstrap, whose lane is its workspace (`runs.lane`), so one workspace's bootstrap never supersedes
another's. Before it starts, under the
environment's lease, Control fails it with the run-log line `superseded by run <id>`. That covers a run the queue
redelivered late and a parked run approved after a newer deploy went live: re-running the older commit is a new
deploy.

### 7. The approval page leads with who gains access

A deploy of an agent-authored change can carry hundreds of lines, most of them harmless. The approver must see in one
glance who gains access to what, and the few lines that decide it. The page is built from the facts of section 3,
never from the words of a line:

- **A summary first, in plain words.** The head says what the change does to endpoints ("adds 1 endpoint and changes
  2"), who reaches them per caller group, what else it changes (tables, roles, migrations), whether it waits, and what
  to check first: every closer-review line, each with its reason; without one, the widening line most worth a look (a
  new endpoint the most exposed callers reach, else the most exposed widening), and that nothing needs closer review.
- **Grouped by caller.** The facts of an endpoint fall under its audience, in the order and words of the environment
  page's surface: anyone, the share links of each link mount, another application, machines, and signed-in people,
  each endpoint's requirement on its row. An endpoint that machines and signed-in people both reach stands in a group
  of its own, "Machines and signed-in people", so a title never names fewer callers than its rows admit. A removed
  endpoint or mount whose paths now reach a more exposed endpoint stands there with every line about it, and the head
  counts removed endpoints and mounts apart from the endpoints that change. Facts on any other subject form a second
  part, data and runtime, grouped by subject kind: tables, roles, jobs, migrations, the application. A group is named
  by the contract's identifiers (a link mount name, a requirement's action); the contract declares no display label for
  them. A group's heading counts its rows, the unit the approver sees ("2 endpoints, both widen access"), not its lines.
- **A row says each fact once.** A row names its endpoint, route and requirement in its own columns, so a line there
  shows the words the diff built for a row (`inRow`: "New endpoint, answering a stored file of kind `rendered`"; only a
  comparison that phrases its lines from the endpoint's name sets them, the rest keep their whole line), and
  what stands in front of the endpoint leaves out the notes a line of the row already states (`states`). Identifiers
  set in backticks render as code everywhere on the page.
- **Rank is derived, there is no severity field.** Groups and facts are ordered by effect and review (a widening with
  closer review, a widening, a narrowing with closer review, a neutral line, a narrowing), then by reach, anyone
  first. Nothing else enters the rank, so it cannot disagree with the classification.
- **A warning says why.** Wherever a closer-review fact shows, in a row, in the summary or among every line, it shows
  one fixed sentence for its reason; `anyone-calls` on a kick, for example, reads "anyone on the internet decides when
  job `mailing` runs". A group's heading counts the endpoints that need closer review and points to their rows.
- **Protection is shown, not asked for.** A procedure shows its effective admission from the candidate snapshot
  beside it, in the words of its diff line: buckets, challenge, body limit, how long it waits for the body and its
  time limit. Limits that are the framework's defaults (the surface marks them) are said once for the section, and a
  row marked "default limits" has them, so only an endpoint's own limits stand on its row. A public one without a
  bucket or a challenge says so. The page never asks the approver to verify
  something the snapshot states. Whether a bot check holds is read from the endpoint's challenge, never from a browser
  config variable: a removed `siteKey` variable is a line about what a page reads, and a dropped challenge is its own
  widening line on the endpoint. The environment's cross-origin list is named as section 3 says, and nothing presents
  it as protection.
- **Similar facts fold, widenings stay in view.** Facts of one rule and one effect on three subjects or more fold into
  one row ("body limit on 40 endpoints"), unless they widen or need closer review: those never fold. A group the page
  collapses by default holds no widening fact, so every widening is visible without expanding anything.
- **Grouping decides nothing.** Whether the run waits is `classifyAccess`'s outcome alone. The grouping is a pure
  function over the facts, beside the DTO in `@fabrika/control-contract`; a test holds that it keeps every fact, and
  that the widenings it shows by default are exactly the widenings of the classification.
- **The lines stay.** The three effect sections of section 3, with search and a filter, are one step away. They are
  the same facts, unordered.
- **A run says where it stands.** Approval and publication are two steps (section 2): an approved run is
  queued again and classified once more before it publishes. The page shows which of these holds: approved and waiting
  to run; published; the approval lapsed, because an older run published another change first and the change still
  widens against it, so the run waits for a new approval; or superseded, because a newer run published first, and an
  older run never deploys over it (section 6). A refused or cancelled run says so, and so does a run
  that published before its cancellation took effect. A run that never waited, because its change does not widen or
  its environment is not protected, says it published without waiting for approval. Parking a run again
  keeps the approval it held: it names the digests it approved, so it approves nothing the new classification shows,
  and `ApprovalDto.approval.holds` says it lapsed. Refusing or cancelling such a run drops the approval, so a decided
  run never reads as approved for what nobody approved.

## Consequences

- An agent can no longer take a step off the road on production silently: such a change, or a migration with a
  statement not known to keep every stored value, waits on `prod` until a human reads the plain-language
  lines and approves. A plain widening (a new endpoint for signed-in people, a new role, a new migration whose every
  statement is known to keep every stored value) publishes on `prod` at once; its lines stay on the run
  and the environment page lists the published surface, so it is reviewed after the fact, not before.
- A run that an earlier release parked for a widening alone still waits after the upgrade, and the approval page says
  it waits, whatever its stored lines need under this rule.
- A removal deploys without a prompt, unless the endpoints that answer its paths now admit a caller the removed one
  did not, or it removes a column read policy. Moving a page's paths to another page for the same callers, the usual
  refactor, does not prompt. A change of handler code that leaves the shell and the migrations as they were deploys without a prompt too. A
  change that declares a new step off the road, or widens one, waits. Unprotected environments, including staging and
  MCP authoring targets by default, do not wait.
- A deviation is not a refusal. The approver sees each one marked for closer review; what an admitted statement can
  then do in Postgres is bounded by the application's role family
  ([ADR-0017](0017-service-owned-postgres-migrations.md)), not by the approval and not by the classifiers' name
  rules, which are defense in depth.
- The first deploy to a protected environment waits only when it holds a closer-review line: against the empty
  snapshot, every item is an addition, and every step off the road among them is marked.
- An agent cannot unprotect an environment to avoid the prompt: the flag change needs the same human
  approval.
- Every path that touches published access goes through one function and one compare-and-swap. A new
  write path must use `approvedSnapshot(app, env)`; a path that reads the provider artifact for access
  data is a bug.
- The diff is conservative. It does not recognize a harmless addition and shows no head counts. Parking only on
  closer-review lines keeps approvals on `prod` to the changes a person has to read the code behind; the number of
  prompts per deploy must still be measured. For a removal it takes the smallest step towards a reachability classifier: it compares
  who the endpoints that answer the removed paths admit with who the removed one admitted, field by field over every
  field of an endpoint row and its delegation. The comparison is total over `EndpointRow`, so a field the proxy
  comes to apply fails Control's typecheck until the comparison decides it; it is never waved through. Additions are
  still all widenings.
- Rolling Control back below the version that wrote three effects breaks reading every run that version classified
  (the older schema is strict and knows only `widens`): the approval page, the approvals list and MCP's
  `get_deployment` fail for those runs. Before 1.0 that is accepted; no dual format is written. The same holds for
  rolling back below the version that writes structured facts (section 3). Rolling back below the version that records
  file adoptions, or data loss with its `deletes-data` reason, breaks only the runs whose snapshot or classification
  holds one (a deploy waiting for approval fails when it resumes); the environment's publication never carries them,
  so every other deploy and republish still reads it.
- A run classified before lines carried facts keeps its stored lines without `rule`, `subject` or `audience`. The
  approval page shows them in their effect sections as unsorted lines and builds no groups for that run; a parked run
  that is classified again gets facts. No migration rewrites a stored classification.
- Every comparison in `diff.ts` must emit its rule and subject beside its words. A comparison added without them is a
  type error, not an unsorted line.
- The approval proves a signed-in user with `access.approve`, not a physical human. An agent that drives
  the approver's own signed-in browser can approve. The skill forbids it; WebAuthn on
  `approvals.complete` is the next step.
- A rollback that restores removed access is classified like any other change: it waits when it restores a step off
  the road.
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
