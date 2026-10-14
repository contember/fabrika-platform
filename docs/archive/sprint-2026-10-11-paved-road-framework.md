> **OUTCOME — shipped 2026-10-13.** An agent writes a Fabrika application on a paved road. The
> [first part](sprint-2026-10-11-paved-road-core.md) built the framework (WU0–WU10, WU12, WU13a, WU13b, WU14, WU18).
>
> **Shipped in this part.**
>
> - The public intake gaps: a link for an anonymous visitor issued by a job, with link-holder files (WU15); a form
>   that kicks its job (WU15b); per-client admission, a honeypot and a challenge (WU16); malware quarantine (WU17);
>   CSV downloads (WU19); HSTS and 5xx reports to Operations (WU20); the skill for all of them (WU10b).
> - From the trials: the member lookup below its dimension (WU22); application-wide data with `{ action, app: true }`
>   (WU23a); the private dogfood's cheap fixes (WU23b); an `app` capability's SQL scope held to what `ctx.db.app`
>   reaches (WU23c).
> - The acceptance (WU11): the CRM in `examples/crm` at 386 hand-written server lines against the baseline's 538
>   (−28 %), with 160 tests.
>
> **Commits** (first…last on main):
>
> - WU20 `99c81709`…`6f7ba0e6` · WU17 `af28a8ee`…`a600106b` · WU22 `75254085`…`f339fb79` · WU11 `9e49d9c3`…`0c13d394`
> - WU16 `fda16209`…`d85cfffe` · WU19 `d74741e1`…`3eb0336e` · WU15 `681880fd`…`924b5387` · WU15b `f346a607`…`af32c77f`
> - WU10b `c52ecf3c`…`debb4e58` · WU21 `74f72ac5` (its backlog) · WU23a `421ea9df`…`051b65c9`
> - WU23b `0049735e`…`d613b688` · WU23c `22a43f62`…`440affe9` · leftover findings `bf167362`
> - Flaky-test fixes `6bf104fa`, `abe5a3cd`, `85b09dbc`; the 0.3 release fixes `e291e1ec`…`c732b94e`, integrated before WU23c
> - After the close: WU24 `0167ca15`, `c6a4d69b` · WU25 `de0876ee`…`c4bf574b` · WU26 `53ec19f4`, `ea809026` ·
>   the test caller's label `aedd6992` · the loop's wording `d156bb44`
>
> **Verification** at `440affe9`: typecheck, lint, `format:check`; `bun run test` with Postgres and S3 7299 pass, 38
> skip, 0 fail; agent interfaces 318, `examples/zerops-app` 47, `examples/crm` 160 pass.
>
> **Trials.** Deviation trial: nothing refused, every off-road step shown as closer review, on the CRM and in a parked
> Notes run. Fresh-agent trial (cap: 3 tsc and checker runs per endpoint group): 3 of 6 agents in round 1, 5 of 6 in
> round 2, and by round 6 every group had met it. Private dogfood: 123 passing tests, far over the cap; its findings
> became backlog 121–133.
>
> **Backlog.** Closed: 102 (WU20), 125 (WU23a), 121, 123, 124 (WU23b); 110 and 71 are in the first part. Filed:
> 111–137. Each has since shipped or was dropped (127), except 116 (Zerops facts and ClamAV on a real account), 117
> (fault injection in an application test), 122 (seeding a child row's state) and 135 (deleting a Zerops secret).
> Deferred: per-client form admission on Zerops, where the client is the balancer (05); HSTS on IAM's and Control's
> hosts (163). Out of scope: a data layer on Cloudflare, so a contract with a job does not boot there. Not run at the
> close: `tests/browser/notes-agent-adds-endpoint-and-table.test.ts`.

# Sprint — the paved-road application framework (2026-10-11)

**Goal.** An agent writes a Fabrika application on a paved road: a declarative shell, handlers colocated with their
endpoints, a mini-ORM scoped by the endpoint's capability, and raw SQL when it needs it. Every step off the road is
declared in the shell, so the human who approves the deploy sees it.

**Theme.** The platform guarantees two things at the high level: nobody reaches an endpoint outside authorization
(the proxy, [ADR-0022](../decisions/0022-the-proxy-is-the-only-enforcement-point.md)), and a widening waits for a human
on a protected environment ([ADR-0050](../decisions/0050-approved-access.md)). What a handler does with data is the
code's and the review's job. The framework makes the straightforward way the sound way. A step off the road (raw SQL,
an unscoped table, a connector, database code) is a declared deviation: allowed, bound to its endpoint at runtime, and
a review signal instead of a refusal. Success is the CRM rewritten in the new form, shorter than the dogfood baseline,
written by fresh agents from the skill alone, with an off-road request declared, flagged and parked for approval.

The shipped units of the first part, its evidence and its sequencing steps 0–6a are in the
[first part](sprint-2026-10-11-paved-road-core.md).

## Target shape

```text
src/vocabulary.ts                   defineVocabulary({ app, dimensions, actions, roles }): the authorization vocabulary
src/db/tables.ts                    defineTables(vocabulary, columns)({ … }): table scopes typed by the vocabulary
src/db/schema.generated.ts          codegen
src/app-kit.ts                      defineApp(vocabulary, tables): the kit, typed by the vocabulary, DB and policies
src/schemas.ts                      shared zod schemas (literal), imported by the shell and the SPA
src/<slice>/endpoints.ts            app.group(…) with .handle(…) bodies: a shell module, sliced by the reader
src/<slice>/logic.ts                business rules: plain TypeScript, no ctx, no data access
src/<slice>/queries.ts              reusable data access over the handle a handler passes in
fabrika.contract.ts                 app.contract((c) => …): mounts and sections composing the slices' groups
src/app.ts                          serve(contract, { database, deps }): the composition entry build.ts and the job CLI load
db/migrations/*.sql                 plain SQL; declared database code is a deviation
web/                                the SPA: the contract's types, src/schemas.ts and @fabrika/app/client only
src/**/__tests__/                   generated tests (committed, never edited) and authored tests and fixtures
```

The order breaks the type cycle: the vocabulary knows nothing, the tables know the vocabulary, the kit knows both, and
the groups and the contract know the kit. Nothing imports `typeof contract` to type a table.

**Names.** `ctx.target` is the capability (a `Ref`) the access form minted; `ctx.db.target` is the data handle bound
to it. `ConflictError`, `NotFoundError` and `BadRequestError` come from `@fabrika/app` only. A paved-road mutation
answers `Saved = { id, version }`.

**Declared off-road fields** (literal, in the shell, read by Control, part of the contract digest):

| Field                                      | On                     | Runtime effect                                                                                   |
| ------------------------------------------ | ---------------------- | ------------------------------------------------------------------------------------------------ |
| `sql: 'read' \| 'write'`                   | endpoint, job, webhook | `ctx.sql` exists only here; `'read'` runs read-only; a query or export may declare only `'read'` |
| `unscoped: { <table>: 'read' \| 'write' }` | endpoint, job, webhook | `ctx.db.unscoped.<table>` exists only for those tables, in that mode; only tables of `tables.ts` |
| `connect: ['<connector>']`                 | endpoint               | `ctx.connect.<connector>` exists only here (replaces the import's `usedBy`)                      |
| link issuing (`issues: '<mount>'`)         | endpoint, cron job     | `ctx.links.issue` exists only here                                                               |

A new declaration, a new table or a mode change (`read` → `write`) is a widening with a "needs closer review" line.
The checker's syntactic lint is a hint, not the boundary.

## Work units

### WU11 — Acceptance: the CRM in the new form (L)

- **Scope.** `examples/crm`: the dogfood CRM in the new structure with the same surface, plus `deals.reopen` under
  `getForUpdate`, `deals.source` and a pipeline report, in `test:examples`. Pass bars: at most 400 hand-written server
  lines and no file that only mirrors another; a fresh-agent trial from the skill alone at most 3 tsc and checker runs
  per endpoint group, no edited generated file, no loosened access; a deviation trial in which nothing off the road is
  refused and every step shows as closer review, parked on a protected environment.

### WU15 — A time-limited credential for an anonymous visitor (L)

- **Decision: a form runs no handler.** A form stays append-only with a constant answer, and a job does the work. An
  anonymous request then costs one bounded insert and answers nothing that depends on data, so it is no enumeration
  oracle and no amplifier; the job runs under its own workload identity with declared actions and per-recipient budgets.
- **Scope.** A cron job may declare `issues: '<link mount>'`; `ctx.links.issue` and `ctx.links.revoke` exist only
  there. IAM accepts a job's workload token on `issueLink`, and on `revokeLink` of a link that job issued, and nothing
  else. Link-holder file collections (`link: true`) under the mount, owned by the link's object. Single use is
  application state (a `verify` mutation under `getForUpdate`); revocation is the IAM-side stop. A job's `issues`
  widens with closer review.

### WU15b — Jobs triggered by forms (S–M)

- **Decision: a form kicks its job.** `then: '<job>'` on a form starts one run of that cron job after the insert
  commits and the constant answer is sent. Kicks coalesce on the job's lease plus a pending flag: at most one run and
  one pending. The cron schedule stays the recovery path. A kick carries no payload, so this is not `ctx.jobs.enqueue`,
  and a `then` widens nothing in the approval.

### WU16 — Anonymous abuse control (S–M)

- **Decision.** Per-client admission lives in the framework, keyed on the proxy's `X-Fabrika-Client-Ip`, in a shared
  table beside a per-form ceiling; the proxy stays stateless. A declared honeypot field answers a filled form with the
  same `{ received: true }` and writes nothing. A declared challenge (`turnstile`, a closed provider list, the secret an
  application variable) is verified before the row is written. `csp: { scriptSrc, frameSrc }` take exact `https://`
  origins; a new origin widens. On Zerops the client is the balancer until backlog 05, so the challenge is the defense
  that does not depend on the address.

### WU17 — File malware quarantine (M)

- **Decision.** `c.files(name, { scan: true })`: an upload ends `quarantined`; a scan pass in the application's own
  container, under a reserved framework job, streams it to `clamscan` and marks it `live` or `rejected`. No scanner
  service. It fails closed on every environment: a missing binary, missing signatures or an error leaves the file
  quarantined, and the provider build installs `clamav` for any scanning collection. A download serves only `live`.
  A generated `files.<name>.list` query closes dogfood finding 10.

### WU19 — File-download responses (S/M)

- **Decision.** `c.attachment({ format: 'csv', filename, row, maxBytes })` on a query or a mutation: the handler returns
  rows, the framework encodes them with RFC 4180 quoting, per-cell formula escaping and incremental size bounds. An
  audited export is a mutation that inserts its log row in the invocation's transaction. XLSX went to the backlog (111,
  since shipped). `@fabrika/app/client` gains `download`.

### WU20 — Operations and headers (S)

- **Decision.** HSTS (`max-age=31536000`, no `includeSubDomains`, no `preload`) on every answer of an `https`
  application host, set by the proxy. A handler 5xx sends one Operations event with failure codes only, never an
  error's name, message or input. Every SPA mount serves `__fabrika-config.json` with the browser DSN and the release
  (backlog 102).

### WU10b — The skill for the gap units (S)

- **Scope.** The skill's reference files describe the public SPA, attachments, scanning and link-holder files, a job's
  `issues`, forms' admission, and the public intake recipe, in its own `references/public-intake.md`.

### WU21 — Private dogfood: the public intake module (L)

- **Scope.** A fresh agent builds the module outside every public repository, from locally packed packages and the
  skill alone. Each platform finding comes back as a backlog item in generic words.

### WU22 — The member directory below its dimension (S–M)

- **Problem.** An endpoint below the org could not check that a picked person is a member of the org, so the road
  trusted a client-sent `{ principalId, label }`.
- **Decision.** `ctx.members.get(principalId)` at the nearest dimension that declares `members`, at the value of the
  `Ref`'s chain the framework read from the database. IAM authorizes the lookup itself (`findMember`) by the endpoint's
  own action, which must be one of the dimension's approved `lookups` and held on the directory's value. It answers one
  named member or `null`, cannot enumerate, and labels stay opt-in. The artifact records each endpoint's directory reach;
  a new reach widens → [ADR-0012](../decisions/0012-fabrika-app-runtime.md), `packages/iam/CLAUDE.md`.

### WU23a — Application-wide data (M–L)

- **Problem.** Every access form and writable table scope named a dimension, so data of the whole application had no
  place on the road (backlog 125).
- **Decisions.** The access form `{ action, app: true }`, met only by a global grant, checked once by the proxy. The
  table scope `{ app: '<why>' }`: an application table with actions, versions and a UUIDv7 key, no container.
  `ctx.app` and `ctx.db.app` (option (i)): the application tables by their actions, and read-only every dimension
  table whose read action is the endpoint's. Option (ii), an `over` endpoint writing when its `Within` is `'all'`, is
  rejected: whether it may write would depend on each caller's grants at run time. Neither form is a deviation; a
  requirement change widens → [ADR-0012](../decisions/0012-fabrika-app-runtime.md), ADR-0022, ADR-0050.

### WU23b — The dogfood's cheap fixes (S)

- **Scope.** A form's input is typed by its inbox's columns; an `unscoped` write of a reference or inbox table is
  refused by the types and `buildArtifact`; `@fabrika/app/testing` re-exports three option types; the skill's fifteen
  gaps (backlog 121, 123, 124).

### WU23c — An app capability's SQL scope reaches only what `ctx.db.app` reaches (S)

- **Scope.** `ctx.sql.scope(ctx.app, table)` rendered `(true)` for any table; it now refuses a table `ctx.db.app` does
  not list for the capability's action.

### Design review of the gap units (binding)

A design review at `77683fa2` added: WU15 — IAM checks a job's approved `issues` mount; link-file routes check the
mount and the current owner chain; durable progress across IAM and e-mail. WU16 — atomic buckets with expiry,
admission apart from the submission quota, strict challenge verification. WU17 — only a completed clean verdict
promotes a file; quarantined uploads count against the quota. WU19 — CSV only, formula escaping before quoting,
incremental bounds. WU20 — failure codes only; HSTS on every response, on both providers.

## Out of scope (explicit)

- **Declared operations** (`c.read`/`c.update` with `when`/`set`/`inc`): too declarative. Business logic is TypeScript.
- **Row-level security**, a static proof of data security, an isolated handler host or a platform data executor
  (decision 1; ADR-0012's Alternatives).
- **A syntactic detector as the boundary**: destructuring, helper modules and `ctx[k]` evade it. It stays a hint.
- **Deriving zod inputs from rows**, file-based routing and entity sugar (the spikes).
- **`ctx.jobs.enqueue`**, form inbox reads and list writes on the road: `unscoped` or `sql` cover them, declared.
- **A form with a handler** (WU15), a single-use credential in IAM, a rate counter in the proxy, a scanner service.
- **A framework audit API for applications**: application audit is application tables (WU18 §5); delivery from
  Control and Operations stays in [backlog 71](../backlog/71-deliver-domain-audit-events-durably.md).
- **Outbound e-mail as a declared reach**: an application sends through `deps`, as plain code.
- **Backup and restore tooling**: the operator's.
- **Two-capability access** ([backlog 97](../backlog/97-the-generated-tests-have-no-move-case.md)) and
  **destructive-migration rules** ([backlog 98](../backlog/98-application-migrations-have-no-destructive-change-rules.md)).
- **A data layer on Cloudflare**: still Bun and Postgres only.

## Decisions

Owner decisions, binding:

1. **Declarative shell, arbitrary code.** The shell is the vocabulary, endpoints, jobs, files and webhooks. Business
   logic is TypeScript. No operation grammar, no RLS, no isolated host, no static proof of data security.
2. **The platform protects at the high level:** the proxy admits only authorized calls (ADR-0022); a human approves
   every widening on a protected environment (ADR-0050).
3. **A paved road with strong guarantees:** the mini-ORM scoped by the endpoint's capability, which reads its own
   target; `expectVersion` and `getForUpdate`; `fromRow`; names derived from the vocabulary; `.handle()` colocated with
   the endpoint and sliced off by the reader; no mirrored `implement` tree.
4. **Raw SQL is legitimate**: `ctx.sql`, parametrized, in the endpoint's transaction.
5. **Deviation is a review signal, not a refusal.** Hard refusals stay only for platform integrity: secrets,
   framework internals and `fabrika_*` objects, escaping the schema or the transaction.
6. **Migration SQL**: refuse only escapes; database code becomes a deviation.
7. The 105/106/109 hardening and 107 stay.
8. **The application architecture** is a reference document (WU1); the examples and the CRM follow it.
9. **Agent skills** ship in `@fabrika/app` and are the only text the fresh-agent trial sees (WU10).

Revision decisions (after two independent reviews), binding:

10. **The staged kit lands first** (WU0), so WU2–WU4 implement against fixed signatures.
11. **Off-road reach is declared in the shell**; the runtime builds each handle only for the declaring site.
12. **`fabrika_*` objects are reserved**: refused in `ctx.sql`, in migrations, in any body, and in `unscoped`.
13. **A function allowlist, not name rules**, for bodies, expressions and `ctx.sql` text.
14. **Backlog 110 is pulled in** (WU12): the role is the boundary, the name rules are defense in depth.
15. **The transaction is the invocation's** (WU3 §4).
16. **Own-target read hides every column of another action**, in data and type.
17. **The snapshot holds only data-reach deviations**; structure findings are checker hints.
18. **The seven gaps of the public intake application are in this sprint** (WU14–WU20), with a private dogfood (WU21).
19. **Simple designs:** no new service, no complex orchestration.

Resolved: the catalog check is the runtime witness, not the detector; domains stay refused; one skill with reference
files; the per-client bucket lives in the framework; the scan fails closed everywhere; `auth_log` retention is WU18's;
HSTS has no `includeSubDomains`.

## Sequencing

Steps 0–6a are in the first part. 6a: WU17. 6b: WU15, WU20. 6b': WU15b. 6c: WU16, WU19. 7: WU10b. 7b: WU22. 8: WU11,
WU21. Each unit ran in its own worktree; where two units of a step shared a contract seam, the second to merge rebased.

## Run log

- WU14: a public SPA's row kind carries publicness, so no existing row or digest changed →
  [ADR-0022](../decisions/0022-the-proxy-is-the-only-enforcement-point.md) (anonymous kinds).
- WU10: what the trial application taught → backlog 112, 113; `ctx.sql.scope` and the fragment's placement →
  `packages/db/CLAUDE.md`, [`application-runtime.md`](../reference/application-runtime.md).
- WU18: a change's audit row in its own batch → `packages/iam/CLAUDE.md`; the Bun SQL hang → backlog 115.
- WU20: a 5xx reported as a fixed code, closed refusal catalogs → `packages/app/CLAUDE.md`, `packages/db/CLAUDE.md`;
  HSTS and the transport header on early refusals → [ADR-0022](../decisions/0022-the-proxy-is-the-only-enforcement-point.md);
  the installation hosts → backlog 163.
- WU17: the scan, its fail-closed verdicts and retries → `packages/app/CLAUDE.md`; the Zerops facts → backlog 116.
- WU22: the lookup's authorization → [ADR-0012](../decisions/0012-fabrika-app-runtime.md), `packages/iam/CLAUDE.md`
  (`findMember`).
- WU11: an undeclared `ctx.sql` as a `TypeError` → backlog 120; fault injection in a test → backlog 117; the
  owner/assignee validation → shipped in WU22; the page mapping → shipped in WU10b (`fromPage`).
- WU16: a form's admission → `packages/app/CLAUDE.md`, `packages/db/CLAUDE.md`, ADR-0050 (an admission change widens);
  Zerops' client address → backlog 05.
- WU19: CSV only → backlog 111; the attachment output → `packages/app/CLAUDE.md`.
- WU15: the job token, the revocation delay (270 s) and the intake recipe's stops →
  [`application-runtime.md`](../reference/application-runtime.md); `app_workloads.issues` → `packages/iam/CLAUDE.md`.
- WU15b: a kicked run is the job's own → `packages/app/CLAUDE.md`; a `then` widens nothing → ADR-0050.
- WU10b: the trial's gaps → backlog 117, 118, 119; the export across a top-level dimension → shipped in WU23a; a fresh
  application outside the monorepo → the skill's `references/start.md`, backlog 131.
- WU21: the private dogfood's findings → backlog 121–131; at the close → backlog 132, 133.
- WU23a: `ctx.app` → [`application-runtime.md`](../reference/application-runtime.md), `packages/app/CLAUDE.md`.
- WU23b: an unscoped `get` of a keyless table → backlog 136; `sql: 'write'` on a reference table → backlog 134.
- WU23c: a fragment ties no operation or action → backlog 134.
- After the close: trial round 2 → WU24 and backlog 137; rounds 3–5 → WU25, WU26.
