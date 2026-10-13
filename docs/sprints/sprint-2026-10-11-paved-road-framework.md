<!--
On close, prepend an OUTCOME block here, then `git mv` this file to ../archive/:

> **OUTCOME — shipped YYYY-MM-DD.** <one-paragraph result.> Commit map: WU1 → <sha>,
> WU2 → <sha>, … Verification: <the gate command + numbers>. Backlog closed:
> <ids deleted/rescoped>. Deferred: <honest notes>.
-->

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

**Status (2026-10-12).** WU0–WU10, WU12, WU13a, WU13b, WU14 and WU18 are merged on main. Their sections, the commit
map, the evidence carried over, the refs re-verified at HEAD, sequencing steps 0–6a and their Run log entries up to
WU13b are in the [archived first part](../archive/sprint-2026-10-11-paved-road-core.md). A reference in this file to a
shipped unit, to "Evidence" or to a verified ref points there. Still active: WU11, WU15, WU15b, WU16, WU17, WU19, WU20,
WU10b, WU21, WU22 and WU23a.

## Target shape (WU0 fixes the signatures; WU1 the layout; WU3 the API matrix)

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

The order breaks the cycle: the vocabulary knows nothing, the tables know the vocabulary, the kit knows both, and
the groups and the contract know the kit. Nothing imports `typeof contract` to type a table.

```ts
// src/deals/endpoints.ts
export const deals = app.group({ callers: ['human'] }, (r) => ({
	reopen: r.mutation({
		input: ReopenDeal,
		output: Saved,
		access: { action: 'deals.write', on: 'deal', from: 'id' },
	})
		.handle(async ({ input, ctx }) => {
			const deal = await ctx.db.target.getForUpdate()
			if (!canReopen(deal.stage)) {
				throw new ConflictError('only a won or lost deal reopens')
			}
			return ctx.db.target.update({ stage: 'proposal' }, {
				expectVersion: input.expectVersion,
			})
		}),
	pipeline: r.query({
		input: OrgInput,
		output: Pipeline,
		access: { action: 'crm.read', in: 'org', from: 'orgId' },
		sql: 'read',
	})
		.handle(async ({ ctx }) => ({
			rows: await ctx.sql(
				PipelineRow,
			)`select stage, count(*) as deals from deals where org_id = ${ctx.target.id} group by stage`,
		})),
}))
```

**Names.** `ctx.target` is the capability (a `Ref`) the access form minted; `ctx.db.target` is the data handle bound
to it. No other API says "target". `ConflictError`, `NotFoundError` and `BadRequestError` come from `@fabrika/app`
only. A paved-road mutation answers `Saved = { id, version }`.

**Declared off-road fields** (literal, in the shell, read by Control, part of the contract digest):

| Field                                      | On                     | Runtime effect                                                                                   |
| ------------------------------------------ | ---------------------- | ------------------------------------------------------------------------------------------------ |
| `sql: 'read' \| 'write'`                   | endpoint, job, webhook | `ctx.sql` exists only here; `'read'` runs read-only; a query or export may declare only `'read'` |
| `unscoped: { <table>: 'read' \| 'write' }` | endpoint, job, webhook | `ctx.db.unscoped.<table>` exists only for those tables, in that mode; only tables of `tables.ts` |
| `connect: ['<connector>']`                 | endpoint               | `ctx.connect.<connector>` exists only here (replaces the import's `usedBy`)                      |
| link issuing (`issues: '<mount>'`)         | endpoint               | `ctx.links.issue` exists only here                                                               |

A new declaration, a new table or a mode change (`read` → `write`) is a widening with a "needs closer review" line.
The checker's syntactic lint ("declare `sql: 'read'` on `api.deals.pipeline`") is a hint, not the boundary.

## Work units

### WU11 — Acceptance: the CRM in the new form (L)

- **Problem.** No unit alone proves the road is shorter, learnable from the skill, and honest about deviations.
- **Verify first.** The dogfood baseline counts (Evidence); the dogfood CRM's 30 endpoints, job, files and SPA.
- **Scope.**
  1. `examples/crm`: the dogfood CRM in WU1's structure with the same surface, plus `deals.reopen` (`getForUpdate`),
     `deals.source`, and a pipeline report on a declared `sql: 'read'`. Add it to `test:examples`.
  2. **Counts** against the baseline, the same file classes. Pass: at most 400 hand-written server lines (−25 %) and no
     file that only mirrors another; migrations and tests reported apart.
  3. **Fresh-agent trial**: agents that see only WU10's skill files write the CRM's endpoint groups from a feature
     brief. Every tsc and checker run is recorded. Pass: at most 3 runs per endpoint group, no edited generated file,
     no loosened access to make a test pass.
  4. **Deviation trial**: an agent asked for something off the road (a cross-scope admin report; an audit trigger on
     `deals`) declares `unscoped`/`sql` or writes the trigger migration; nothing is refused. On Notes through the local
     stack (protected `prod`), the run parks and the approval page shows "needs closer review"; on the CRM, Control's
     reader and `classifyAccess` over the commit pair show the same lines. An agent that uses `ctx.sql` without the
     declaration gets the checker hint and a runtime refusal.
- **Acceptance / witness.** `bun run test:examples` green with `examples/crm` (Postgres required); counts, trial table
  and parked run in the Run log; the parked run seen in the dashboard (agent-browser screenshot named in the log).
- **Touch points.** `examples/crm/` (new), root `package.json` (`test:examples`), this sprint's Run log.

### WU15 — A time-limited credential for an anonymous visitor (L)

- **Problem.** A visitor who submitted a form holds no credential, so e-mail verification, attachments and
  self-service have nothing to stand on. `issues` is RPC-only (`build.ts:933-937`); a job has no `ctx.links`
  (`jobs/types.ts:21-34`); IAM refuses a workload token on `issueLink` (`packages/iam/src/auth.ts:101-104`); link
  file collections are refused at boot (`collections.ts:339-340`).
- **Decision: a form runs no handler.** A form stays append-only with a constant answer, and a job does the work.
  - **Security.** An anonymous request costs one bounded insert, reads nothing and answers nothing that depends on
    data. A handler gives every anonymous request a transaction and reads. A duplicate check in it is an enumeration
    oracle, unless every answer is constant, and then the visitor gains nothing from the handler. An e-mail per request
    is amplification. The job runs under its own workload identity with declared actions, takes a batch, and applies
    per-recipient budgets in one transaction.
  - **Ergonomics.** The job path uses declarations an agent already knows: a form, a cron job with
    `unscoped: { <inbox>: 'write' }` (`orm.ts:420-438`), this unit's `issues`, and link mutations, which are ordinary
    handlers on `ctx.db.target`. WU10b writes it as one recipe. The cost is latency: the e-mail leaves on the next
    run of the job, within a minute at `* * * * *`.
- **Verify first.** `issueLink`'s delegation rule (`packages/iam/src/membership.ts:578-610`): the caller holds
  `issuedBy` and every grant on some link of the chain. A job's token carries its declared actions with
  `scope: 'app'`; confirm that it meets that rule on any chain. Measure how long a revoked key still works through the
  proxy's token cache.
- **Scope.**
  1. A cron job may declare `issues: '<link mount>'` when its actions include the mount's `issuedBy` and every grant.
     `ctx.links.issue(ref, { mount, days })` and `ctx.links.revoke(id)` exist only on a site that declares `issues`;
     an endpoint gets `revoke` too. A webhook still issues nothing.
  2. IAM accepts a `job` workload token on `issueLink`, and on `revokeLink` of a link that job issued. Every other
     membership operation still refuses a workload token. The link's `issued_by` is the job's principal.
  3. **Link-holder file collections.** `link: true` is served. A collection whose owner dimension is a link mount's
     dimension gets upload, list (WU17) and download rows under the mount's API prefix with caller `link`. The owner is
     the link's object, never a parameter. The mount must grant the collection's write and read actions, or boot
     refuses. Uploads keep their limits and, with WU17, the scan.
  4. **Single use is application state.** A `verify` link mutation sets `verified_at` once under `getForUpdate`; a
     second call answers the same. IAM gets no use counter: the proxy honours a cached token without asking IAM, so a
     per-use count needs shared proxy state (ADR-0022:105). Revocation is the IAM-side stop.
  5. **Resend.** A second form (`{ email }`, constant answer). The job issues a new link for an unverified record
     within a per-recipient budget (an application table) and revokes the previous link.
  6. **Approval.** A job's `issues` widens with "needs closer review", keyed by the job, as an endpoint's does.
- **Acceptance / witness.** A Postgres and IAM test through the proxy on a fixture application: a form row → the job
  issues a link bound to the created record → the holder calls `verify` twice (one `verified_at`), uploads, lists and
  downloads its own files; another record's file id answers 404; another record's link cannot upload here; after
  `revokeLink` the key is refused once the cached token expires. A job without `issues` has no `ctx.links` (a type
  fixture) and IAM refuses its token on `issueLink`; a job token still cannot `assignMember`. A `classifyAccess` test
  for a job's new `issues`.
- **Touch points.** `packages/app/src/contract/{build.ts (#declare for jobs, the file rows),define.ts (the job's
  issues)}`, `packages/app/src/jobs/{types.ts,runner.ts}`, `packages/app/src/implement/membership.ts` (`issue` for a
  job, `revoke`), `packages/app/src/files/collections.ts` (the link caller), `packages/iam/src/{auth.ts,membership.ts}`,
  `packages/auth-core/src/` (only if the RPC shape changes), `packages/check/src/reader/`,
  `packages/control/src/approval/diff.ts`, `docs/decisions/0050-approved-access.md` (one line), their tests.

### WU15b — Jobs triggered by forms (S–M)

- **Problem.** WU15 sends the visitor's e-mail from a cron job, so it leaves up to a minute after the submission: a
  minute is the shortest cron period. A synchronous form handler is refused (WU15's decision): it is an enumeration
  oracle and an amplifier, it gives an anonymous request a transaction, and it couples the public form to the
  availability of IAM and of the e-mail provider. A queue is a new service on Zerops. The form table is already a
  durable outbox, and the job lease already serialises runs.
- **Decision: a form kicks its job.** A form may declare `then: '<job>'` (a proposed name; the implementer may pick
  one that fits the shell better). After the form's insert commits and the constant answer is sent, the framework
  kicks one run of that job in the background: `waitUntil` on Cloudflare, a detached task in the Bun server. The cron
  schedule stays and is the recovery path when the process dies before the run finishes. Kicks coalesce on the job's
  existing lease: if no run holds it, one starts; if one runs, a pending flag makes it run once more after it
  finishes. At most one run is active and one is pending, so a flood of submissions creates no extra work, and the
  job's batch and per-recipient budgets apply as before. The answer never waits for the kick and never depends on it.
  This is not `ctx.jobs.enqueue` (Out of scope): a kick carries no payload, and the job stays a cron job.
- **Verify first.** How a job obtains its workload token today: `packages/app/src/jobs/runner.ts`, `fabrika job run`,
  and the provider's crontab wiring on Zerops and on Cloudflare. A kicked run must run under the job's own workload
  identity, never under the request's. Whether the server process can hold that credential without widening anything;
  if it cannot, the kick spawns `fabrika job run <name>` instead. Cloudflare's `waitUntil` time limit against a job's
  timeout.
- **Scope.**
  1. **The declaration** in the contract: a form names a job that exists. Boot and the checker refuse an unknown job
     and a job that is not a cron job.
  2. **The kick** in the form dispatcher, after the insert commits.
  3. **Coalescing** through the job's lease plus a pending flag in the lease table.
  4. **Approval.** The approval diff shows a new `then` as a change that is not a widening by itself: it reaches only
     a declared, approved job. If the implementer finds a way it widens, flag it in the Run log.
  5. WU10b's public intake recipe uses it.
- **Acceptance / witness.** A Postgres test: a form submission makes the job run within a second, without waiting for
  cron; 50 concurrent submissions produce at most two runs; a kicked run killed before its commit leaves the record
  for the next cron run; the form's answer is identical to the answer without `then` and returns before the run; a
  kick for a job that holds its lease runs the job once more after the current run. A type fixture: `then` naming an
  unknown job fails at its line.
- **Touch points.** `packages/app/src/contract/{define.ts,build.ts}` (the form's `then`),
  `packages/app/src/implement/dispatch.ts` (`#form` only), `packages/app/src/jobs/runner.ts` (a kicked run, the
  pending flag), the lease table (`fabrika_job_leases`, `packages/db/src/migrations.ts`), the provider bundles only if
  the kick needs process wiring, `packages/check/src/reader/`, their tests.
- **Sequencing.** After WU15 (the same job and form files), before WU16: WU16 also edits `#form` and rebases.

### WU16 — Anonymous abuse control (S–M)

- **Problem.** One token bucket per form per process (`anonymous.ts:18-41`): a flood from one address blocks every real
  visitor, and the limit grows with the number of instances. A form has no honeypot and no challenge, and the fixed
  CSP (`script-src 'self'`, no frame source) cannot load a challenge widget (`headers.ts:88-100`).
- **Verify first.** The proxy may not count (ADR-0022:105; `packages/proxy/CLAUDE.md`, "it holds no counter"). It
  already sets `X-Fabrika-Client-Ip` (`caddy.ts:393`, `proxy-worker.ts:130`). On Zerops that value is the balancer
  until backlog 05 settles the trusted range (`docs/reference/zerops-platform.md:75-82`).
- **Scope.**
  1. **Per-client admission in the framework, not the proxy.** The form dispatcher keys a shared bucket in a framework
     table (`fabrika_form_admissions`, one row per form, client address and window) on `X-Fabrika-Client-Ip`, beside a
     per-form ceiling that all instances now share. The defaults live in `defaults.ts`; a form may declare its own
     per-client rate. This is admission, not authorization. Public SPA assets (WU14) have no limit.
  2. **Honeypot.** `c.form(…, { honeypot: '<field>' })` declares one string field that must stay empty. A filled one
     gets the same `{ received: true }` and writes no row.
  3. **Challenge.** `c.form(…, { challenge: { provider: 'turnstile', secret: '<APP_VARIABLE>' } })`. The framework
     verifies the token on the server before it writes the row: a failed check answers 400, an unreachable provider
     503, and neither writes a row. The secret is an application variable, never a contract value. The provider list
     is closed, and each provider's origins are fixed.
  4. **CSP.** `csp: { scriptSrc, frameSrc }` join the existing extensions: exact `https://` origins, at most 16 each;
     `frame-src` is emitted only when declared. A new origin widens (ADR-0050 §3, "CSP extensions").
  5. Until backlog 05 answers, the per-client key on Zerops is the balancer, so the per-client limit equals the
     per-form one. The challenge is the defense that does not depend on the address. The skill says so (WU10b).
- **Acceptance / witness.** A Postgres test: one address empties its bucket and another address still submits; two
  framework instances share the ceiling; a filled honeypot writes no row and answers 200; a challenge stub that fails
  gives 400 and no row, one that is down gives 503 and no row. A proxy-core test: a declared `scriptSrc` and `frameSrc`
  appear in the CSP; a non-`https` or wildcard origin is refused by the build and by the manifest parser.
- **Touch points.** `packages/app/src/implement/{anonymous.ts,dispatch.ts (#form)}`, `packages/db/src/migrations.ts`
  (the framework table), `packages/app/src/contract/{build.ts (form options, csp),define.ts,defaults.ts,artifact-schema.ts}`,
  `packages/auth-core/src/` (`CspExtensions`), `packages/proxy-core/src/{headers.ts,manifest.ts}`,
  `packages/check/src/reader/`, `packages/control/src/approval/diff.ts`, `packages/proxy/CLAUDE.md`, their tests.

### WU17 — File malware quarantine (M)

- **Problem.** Sniffing proves only the type (`packages/app/src/files/sniff.ts:20-40`), and an upload is `live` once
  written (`collections.ts:219-226`). A visitor's attachment reaches HR unchecked.
- **Verify first.** In the Zerops runtime container: Alpine's `clamav` installs through the package allowlist
  (`execution.ts:27-28`, `:280`); `freshclam` reaches its mirror; the peak memory and the duration of one `clamscan`
  over a batch. If the memory does not fit the default container, the unit sets a minimum for a scanning application
  and the skill says so.
- **Scope.**
  1. `c.files(name, { …, scan: true })`. The file status gains `quarantined` and `rejected`. `pending` keeps its
     meaning (the object is still being written; the sweep removes it). An upload to a scanning collection ends
     `quarantined`.
  2. **A scan pass in the application's own container.** The generated crontab runs it every minute under a reserved
     framework job name and its lease (`fabrika_job_leases`). It streams each quarantined object to `clamscan`, marks it
     `live` or `rejected`, deletes a rejected object from the store, and reports a rejection or a failure to Operations
     through the job reporter. No new service.
  3. **Fail closed, on every environment.** A missing binary, missing signatures or a scanner error leaves the file
     `quarantined`. The provider build adds `clamav` and a daily `freshclam` for any `scan: true` collection, so a
     missing scanner is a broken build, not a mode. The local stack's application image installs it too.
  4. **Serving.** A download serves only `live`; `quarantined` answers 409 ("being checked"), `rejected` 404. A
     generated `files.<name>.list` query (id, name, type, size, status, createdAt) under the collection's read action
     closes dogfood finding 10.
  5. `fileTableSql` emits the wider status check. An existing collection that turns `scan` on needs a migration that
     widens the check; the checker names it. Turning `scan` off widens in the approval diff.
- **Acceptance / witness.** A Postgres and S3 test with a real ClamAV: the EICAR string → `rejected`, its object
  deleted, download 404; a clean PDF → `quarantined`, then `live`; a download before the pass → 409; a pass without the
  scanner leaves the file quarantined and reports; the list shows each state. A Zerops render test: a `scan: true`
  contract adds `clamav` and the `freshclam` crontab line.
- **Touch points.** `packages/app/src/files/{collections.ts,scan.ts (new)}`, `packages/db/src/file-table-sql.ts` and
  the file table's accessor, `packages/app/src/contract/{build.ts (the files section),define.ts,artifact-schema.ts}`,
  `packages/app/src/jobs/` (the reserved scan job), `packages/provider-zerops/src/execution.ts`, the local stack's
  application image, `packages/check/src/reader/`, `packages/control/src/approval/diff.ts`, their tests.

### WU19 — File-download responses (S/M)

- **Problem.** A procedure answers JSON only (`dispatch.ts:368`). An HR export must download as CSV or XLSX. Built in
  the browser, each application must get the quoting, the formula escaping and the size bound right on its own.
- **Verify first.** How the client transport reads an answer (`packages/app/src/client/transport.ts`); what the
  proxy's header policy does to a non-JSON answer (`Cache-Control: no-store`, `nosniff`).
- **Scope.**
  1. A procedure output `c.attachment({ format: 'csv', filename, row: <zod object>, maxBytes })`, on a query or a
     mutation. The handler returns rows, and the framework encodes them. An audited export is therefore a mutation
     that inserts its log row in the invocation's transaction and returns the attachment.
  2. A fixed `Content-Type` (`text/csv; charset=utf-8`) and `Content-Disposition: attachment` with the declared file
     name. RFC 4180 quoting. A cell that starts with `=`, `+`, `-`, `@`, a tab or a carriage return gets a leading `'`.
     An encoding over `maxBytes` fails the invocation and sends no partial body.
  3. **XLSX** (`format: 'xlsx'`): a stored (uncompressed) ZIP with inline strings and no dependency, if it stays near
     200 lines with its tests. Otherwise CSV only, and XLSX becomes a backlog item.
  4. The same access forms, callers and approval as any procedure. The snapshot holds the format and the row schema
     as the output shape.
  5. `@fabrika/app/client` gains `download(api.<procedure>, input)`, which saves the file.
- **Acceptance / witness.** A dispatch test: the CSV bytes and headers, with a `=1+1` cell, a quote and a newline; over
  `maxBytes` → an error and no body. An XLSX round trip in the test. A type fixture: a handler that returns something
  other than rows is refused at its line.
- **Touch points.** `packages/app/src/contract/{build.ts (the procedure output),define.ts,artifact-schema.ts}`,
  `packages/app/src/implement/{dispatch.ts (#procedure),attachment.ts (new)}`, `packages/app/src/client/`,
  `packages/check/src/reader/`, `packages/control/src/approval/diff.ts` (the output kind), their tests.

### WU20 — Operations and headers (S)

- **Problem.** The header policy has no HSTS (`headers.ts:88-109`). A handler 5xx is a log line only
  (`dispatch.ts:816-837`). A contract application's browser cannot learn the Operations DSN
  ([backlog 102](../backlog/102-a-contract-application-cannot-hand-its-browser-the-operations-dsn.md)).
- **Verify first.** Where the manifest holds an application host's public scheme (the login bounce takes it from
  there); `operationsReporter` and its envelope (`jobs/report.ts:55-72`).
- **Scope.**
  1. **HSTS.** `Strict-Transport-Security: max-age=31536000` on every answer of an `https` application host. No
     `includeSubDomains`, no `preload`: applications share parent domains. Nothing on `http` (the local stack).
  2. **Server errors.** A handler 5xx sends one Operations event: endpoint id, request id, error name and message,
     release. No input, no headers, no row data. At most a bounded number per process per minute.
  3. **Backlog 102.** Every `spa` and `public-spa` mount serves `<prefix>/__fabrika-config.json` with the browser DSN
     and the release, and nothing else of the environment. Backlog 102's witness and deletion follow its acceptance.
  4. `auth_log` retention is WU18's (IAM's territory).
- **Acceptance / witness.** A proxy-core header test: `https` gets HSTS, `http` does not. A dispatch test: a throwing
  handler sends one envelope without its input. `tests/browser/operations-sdk-ingest.test.ts` passes against the
  Zerops example; backlog 102 is deleted.
- **Touch points.** `packages/proxy-core/src/headers.ts`, `packages/app/src/implement/{dispatch.ts (errorResponse, the
  spa cases),boot.ts}`, `packages/app/src/jobs/report.ts` (the shared reporter), `examples/zerops-app/web/`,
  `packages/local-stack/src/operations-witness/` (deleted), `tests/browser/operations-sdk-ingest.test.ts`,
  `docs/backlog/{102-…md,README.md}`.

### WU10b — The skill for the gap units (S)

- **Problem.** WU10 documents the API as it stands before WU14–WU20.
- **Scope.** Extend `skill/references/`. `endpoint.md`: the public SPA and the attachment output. `files.md`:
  `scan: true`, the file states, link-holder collections and the list query. `webhooks-links-connectors.md`: a job's
  `issues`, `ctx.links.revoke`, and the public intake recipe (public SPA → form → job with an `unscoped` inbox and
  `issues` → link SPA with `verify` and link files → resend). Forms: honeypot, challenge, the CSP extensions and the
  Zerops client-address caveat. Audit: application history and export rows in the invocation's transaction.
  `SKILL.md` gains pointers only and stays within its budget.
- **Acceptance / witness.** `agent-skill.test.ts` passes, every new code block type-checks, and
  `examples/zerops-app/AGENTS.md` is regenerated.
- **Touch points.** `packages/app/skill/`, `examples/zerops-app/AGENTS.md`, `packages/app/src/__tests__/agent-skill.test.ts`
  (only for a new topic).

### WU21 — Private dogfood: the public intake module (L)

- **Problem.** WU14–WU20 come from a validation, not from building the application. A fresh agent with only the skill
  must build the module and show what is still off the road.
- **Scope.**
  1. Built outside every public repository, in a local directory that is never pushed (`intake-dogfood`), from the
     private specification, with this repository's packages packed locally (`bun run release:pack`). The agent reads
     WU10's and WU10b's skill files only.
  2. The surface: the public landing (WU14); the profile form with a honeypot and a challenge (WU16); the job that
     creates the record, issues the link and sends the e-mail (WU15); verification and resend; attachments with the
     scan (WU15, WU17); the HR list, detail, status history, notes, code lists and roles; consent records; an audited
     CSV export (WU19).
  3. Findings stay in that directory. Each platform finding comes back to this repository as a backlog item in
     generic words: no client, product or document name.
- **Acceptance / witness.** The module's generated and authored tests pass on Postgres; `fabrika-check` reports no
  refusal; every deviation is declared and listed. The Run log gets one generic line: the tsc and checker runs per
  endpoint group (as in WU11 §3) and the backlog items filed.
- **Touch points.** In this repository only the backlog items it files and the Run log line.

### WU22 — The member directory below its dimension (S–M)

- **Problem.** An application picks a person for a column such as a deal's `owner` or a task's `assignee`. The member
  directory (`ctx.members`, WU13b) exists only on an endpoint whose own dimension declares `members`; on a `deal` or
  `task` endpoint it is `Unavailable<"the dimension deal declares no members">`. An endpoint below the org cannot check
  that the picked principal is a member of the org, so the paved road trusts a client-sent `{ principalId, label }`
  (the skill's `assign` did). Found by the WU11 review (finding 1) and by three fresh agents of the CRM trial. The
  endpoint that sets the owner holds its own action (`deals.assign`), not the directory's (`crm.read`), and the skill
  forbids checking a second action; and the generated access cases send a sampled id that names no member.
- **Verify first.** `endpointMembers` (`packages/auth-core/src/membership.ts`) and `MembersContext`
  (`contract/context.ts`) decide `ctx.members` from the endpoint's own dimension only. IAM's `listMembers` checks
  `members.list` on the directory's value as a flat scope. The `Ref` of an `on`/`in` endpoint carries the object's
  chain, read from the database for the access form (`#chain` in `dispatch.ts`). IAM's `issueLink` already takes such
  a chain and checks it against the schema's containment (`chainProblem`). The scaffold samples a string as `'x'`; the
  endpoint access kit treats a 400 as a broken fixture.
- **Decision: authorization (review round 1).** A single-member lookup is authorized by the endpoint's OWN action,
  which IAM checks itself (`findMember`) from nothing the application asserts: the action must be one of the
  dimension's `lookups` in the reconciled schema (the actions of the approved endpoints that read this directory), and
  the caller must hold it on the directory's value itself, global grants included. IAM knows no containment below a
  value, so the coarse rule holds: a grant on a contained object (a company, a deal) does not count. The application
  can still misstate which of its approved lookup endpoints asks, never the org, the action's eligibility or the
  caller's authority. Listing stays with the directory's `members.list`, checked live on the directory's value. The
  lookup answers one id the caller named: the member (id, label, disabled) or `null`, never which check failed. It
  cannot enumerate, and labels stay opt-in: `null` unless the dimension declares `directory: 'labels'` or the caller
  manages its members. It is no second enforcement decision (ADR-0022): the proxy and the access form admitted the
  request, and IAM authorizes its own operation, as it does for `listMembers` and `issueLink`.
- **Decision: the ancestor.** The nearest dimension, the endpoint's own or one containing it, that declares
  `members`, at the value the `Ref`'s chain holds: the owner chain the framework already read from the database for
  the access form, never the token's scopes and never the input.
- **Decision: the artifact and approval (review round 1).** `buildArtifact` records each endpoint's reach in
  `ContractArtifact.directories` (`{ dimension, lists }` by endpoint id, absent when none, so other digests stay);
  `directoryReach` derives it and nothing else does, and `endpointDirectory` reads only the record, so an artifact
  without it grants no reach. The digest covers it, `schemaFromContract` gives IAM each dimension's `lookups` from it
  (IAM migration 0009, `app_scopes.members_lookup`), and `classifyAccess` widens on a new reach ("looks up one member
  of", "lists the members of"), with closer review where the dimension shows labels. A baseline compiled before the
  record counts only WU13b's reach (`list()` of the own dimension's `members.list`), so an unchanged endpoint that
  gains a lookup widens on its next approval. Control issues the Zerops membership key for any contract that records
  a reach.
- **Scope.**
  1. `endpointDirectory` (auth-core); `IamMembershipRpc.findMember` (auth-core, `@fabrika/auth`'s client and HTTP
     transport, IAM's operation, binding, `/rpc/*` and `/membership/*`, and its repository query).
  2. `ctx.members` below the dimension: `MemberLookup.get(principalId): Promise<Member | null>` everywhere,
     `MemberDirectory` (`get` and `list`) for the directory's `members.list`, management unchanged. The types
     (`contract/context.ts`, `implement/types.ts`), `facilitiesOf` and the dispatcher decide the same. Jobs get none: a
     job holds no object chain.
  3. The test kit's directory answers `findMember`. `endpoint-access.fixtures.ts` gains
     `export const members = { '<endpoint id>': ['<field>'] }`; the scaffold writes `GENERATED_MEMBER` there, and the
     endpoint access kit replaces it with a real member of the case's org.
  4. The skill's `assign` validates the picked person with the lookup and stores its label; AGENTS.md regenerated.
- **Acceptance / witness.** `packages/local-stack/__tests__/member-lookup.test.ts` (Postgres, the real IAM, the
  production proxy, the fixture org → company → deal): a deal endpoint's lookup answers the org's member with its
  label and `null` for a member of another org and for an unknown id; an assignment stores the directory's label and
  refuses an outsider (400); a caller holding the endpoint's action on the org, without `crm.read`, looks a member up,
  and one holding it on the company alone is refused (403); a caller holding `crm.read` on the company alone is refused
  the org's list (403, IAM's live check); another org's caller gets 404. IAM's `findMember` refuses a substituted
  scope with a grant it cannot place, an action no lookup endpoint holds (the global creation action included) and
  another application's action. `classifyAccess` widens on a recorded reach against a baseline without the record.
  The leak cases catch a handler that answers another org's member, for `on` and `in`. `packages/app/src/__tests__/members-lookup.test.ts`: the type fixture (a deal endpoint's `ctx.members`, and
  `Unavailable` where no dimension above declares members), the kit's directory, and the fixture's committed generated
  tests (with a `members` field), which pass and are current. IAM's `findMember` rules in `membership.test.ts` and on
  Postgres.
- **Touch points.** `packages/auth-core/src/membership.ts`, `packages/auth/src/{membership,rpc-http}.ts`,
  `packages/iam/src/{membership,rpc,rpc-http,rpc-inputs,membership-http,index}.ts` and `repositories/membership.ts`,
  `packages/app/src/{contract/context.ts,contract/defaults.ts,implement/*,testing/*}`,
  `packages/check/src/{endpoint-fixtures,scaffold}.ts`, `packages/control/src/{membership-transport,approval/diff}.ts`,
  `packages/app/skill/`, `examples/zerops-app/AGENTS.md`, their tests. Not `examples/crm`: WU11 adopts it.

### WU23a — Application-wide data (M–L)

- **Problem.** Every access form (`over`, `in`, `on`, `creates`) and every writable table scope names a dimension, so
  data that belongs to the whole application has no place on the paved road: a code list an administrator edits,
  operational counters, the audit row of an export across every record. A single-tenant application, whose roles are
  all global grants, meets it first; the private dogfood (WU21) wrote such data as `over: '<dimension>'` plus `sql`
  into a reference table, and could not build the audited export (backlog 125).
- **Verify first.** `satisfies` (`packages/auth-core/src/requirement.ts:13`–`:21`) is the requirement check the proxy's
  one decision runs (`packages/proxy-core/src/authorize.ts:259`) and the framework repeats; `permits(entries, action)`
  without a scope is met only by a global entry (`permissions.ts:41`). `over` under a global grant mints a `Within` of
  `'all'` (`dispatch.ts:577`–`:579`), and its predicate is `true` (`store.ts:207`). A reference table is read-only
  (`ReferencePolicy`, `packages/db/src/policy.ts:97`); an inbox is written only by its form.
- **Decision: the access form `{ action, app: true }`.** `app` is the word the shell already uses for the whole
  application (a job's `scope: 'app'`). The artifact's requirement is `{ kind: 'action', action, access: { form: 'app' } }`.
  It is allowed on an RPC mount's `query` and `mutation` and on an SPA; a link procedure stays on its object, an export
  keeps its one dimension (v1), and files, jobs and webhooks keep their own forms.
- **Decision: the proxy checks it, once.** The requirement is the action held as a global grant: `satisfies` answers
  `permits(perms, action)` with no scope for `form: 'app'`, so only an entry with `scope: null` meets it. The proxy's
  decision (`@fabrika/proxy-core`) runs `satisfies` and refuses a caller who holds the action only in some scope
  with 403, before the application sees the request; the framework repeats it as authorization, as for every form. No
  new check exists anywhere else (ADR-0022): the access form only mints the capability.
- **Decision: the table scope `{ app: '<why>' }`.** An application table holds rows of no dimension. Like a dimension
  table it has `actions` (`read`, `insert`, `update`, `delete`), `insert`/`update` lists, `version`, `createdBy`,
  column actions and a `key` (default `id`, generated as a UUIDv7 on insert); it has no container and no chain. A
  reference table stays migration-managed and read-only, so a code list an administrator edits is an application table.
- **Decision: the handle `ctx.db.app`, option (i).** An `app` endpoint gets `ctx.app`, the capability of its action
  held application-wide (as `ctx.target` and `ctx.within` are the other forms'), and `ctx.db.app.<table>` built from it. An application table: `list`, `count` and `aggregate` with its read action;
  `get(id)` and, in a mutation, `getForUpdate(id)` with any action the table names (the columns of that action, as a
  `Ref` reads its own target); `insert`, `update(id, …, { expectVersion })` and `remove(id, …)` with that operation's
  action. **Every dimension and child table whose read action is the endpoint's action** is there too, read-only
  (`list`, `count`, `aggregate`, every row), as `over` with `'all'` reads it today. So an audited export of every
  record is one `app` mutation that reads the records and inserts its log row into an application table whose insert
  action is the export's action, in one transaction. Option (ii) (an `over` endpoint that writes an application table
  when its `Within` is `'all'`) is rejected: whether it may write would depend on each caller's grants at run time, and
  a scoped caller would fail inside the handler instead of at the proxy. Option (i) adds no authority: a global holder
  of the action already reads every such row through `over`. An application table is read only by an `app` endpoint;
  data that every caller (a link holder, a scoped member) reads stays a reference table. A job reaches application
  tables only through `sql` or `unscoped`, as before.
- **Decision: approval (ADR-0050).** The new form appears in the endpoint's line ("with `<action>` (app-wide)"), and a
  change of an endpoint's requirement, to `app: true` included, is a widening (as every requirement change is). A new
  application table's line names its reason and each of its actions; a changed scope or action of a table widens as
  before. Neither is a declared deviation: the form is on the paved road.
- **Decision: the generated tests.** The endpoint access test gets two cases per `app` procedure for a person or a
  machine: a caller who holds the action in one scope only is refused by the proxy (403), and a global holder reaches
  the endpoint (an answer of the application, no 401/403/404/5xx). The policy isolation test of an application table
  probes the data layer through an `app` probe contract: a global holder of the table's actions gets, lists, counts,
  inserts, updates and removes; a holder of the same actions in one scope only is refused (403) on each; a capability
  of the read action is refused an update or a remove the table gives another action.
- **Scope.**
  1. `AccessForm` and `TableScope` in `@fabrika/auth-core`; `satisfies`; the proxy manifest parser; every reader of
     an access form's dimension (`endpointMembers`, `endpointDirectory`, the delegation) treats `app` as none.
  2. The contract: the declaration and kit types, `buildArtifact`, `parseContractArtifact`, the static reader.
  3. `@fabrika/db`: the `app` policy (parse, types, `DbIndex`), the app capability, `ctx.db.app` (`orm.ts`), the
     table probe.
  4. `@fabrika/app`: the capability class and mint, `#access`, `ctx.db.app` by access form (types and runtime).
  5. The testing kits and `fabrika db test-scaffold`; `classifyAccess`.
  6. ADR-0012, ADR-0022 and ADR-0050 in place; `docs/reference/application-runtime.md`; the skill's `endpoint.md`,
     `table-and-migration.md` and `public-intake.md` (an administrator-edited code list and an audited export of
     every candidate on the paved road, no `sql`, no `unscoped`); `examples/zerops-app/AGENTS.md`.
- **Acceptance / witness.** The public intake recipe's code list and audited export type-check and migrate in
  `skill-code.test.ts`, with no `sql` and no `unscoped` on them. A generated endpoint access case refuses a holder of
  the action in one scope (403 from the proxy) and admits a global holder (`endpoint-access.test.ts`). The policy
  isolation probe covers an application table (`policy-isolation` cases, generated by the scaffold). `satisfies` and
  the proxy decision refuse a scoped holder of an `app` requirement (auth-core and proxy-core tests). `classifyAccess`
  widens on a change to `app: true` and names a new application table's actions.
- **Touch points.** `packages/auth-core/src/{contract,requirement,membership}.ts`, `packages/proxy-core/src/manifest.ts`,
  `packages/app/src/contract/{define,declaration,kit,group,context,build,artifact-schema}.ts`,
  `packages/app/src/implement/{capability,dispatch,invocation,boot}.ts`, `packages/db/src/{policy,orm-types,orm,store,
  capability,testing,vocabulary-tables}.ts`, `packages/app/src/testing/{policy-isolation,endpoint-access}.ts`,
  `packages/check/src/{scaffold.ts,reader/surface.ts}`, `packages/control/src/approval/diff.ts`, the ADRs and docs
  above, `packages/app/skill/references/{endpoint,table-and-migration,public-intake}.md`, their tests. Backlog 125 is
  deleted on merge. WU23b (backlog 121, 123, 124) edits `packages/check/` and the skill's checklist in parallel; the
  second to merge rebases.

### WU23b — The dogfood's cheap fixes (S)

- **Problem.** WU21's agent met three gaps it could find only by probing tsc or the runtime: a form field named unlike
  its inbox column passed tsc and the checker and first failed at boot; `unscoped: { <reference or inbox>: 'write' }`
  passed both and answered 500; and fifteen points where the skill was silent or wrong (backlog 121, 123, 124).
- **Scope.** The kit's `c.form` types its input by its inbox's columns (the honeypot and the challenge token exempt);
  `compileContract` given `defineTables`' result checks the same (`inboxColumns`), and the static reader compiles
  against the parsed policies, so `fabrika-check` reports it. `ReadOnlyUnscoped` refuses `'write'` of a reference or
  inbox table at its key, and `buildArtifact` refuses it too; `insertUnscoped`'s refusal stays. `@fabrika/app/testing`
  re-exports `IamMembershipRpc`, `ChallengeFetch` and `FileScanner`. Each skill entry is fixed in its reference file.
- **Acceptance / witness.** Kit mistakes 33–35 (`kit-types.test.ts`), the matrix rows of `ReadOnlyUnscoped`,
  `contract-refusals.test.ts` and `packages/check/src/__tests__/read-only-tables.test.ts`; `testing-exports.ts` pins
  the three types; `skill-code.test.ts` compiles every block and migrates both catalogs.
- **Touch points.** `packages/{app,db,check}`, `packages/app/skill/`, `examples/zerops-app/AGENTS.md`, the
  local-stack source pin.

### Design review of the gap units (binding)

A design review of WU14–WU21 at `77683fa2` added these requirements; each unit's acceptance includes them:
WU15 — IAM learns each job's approved `issues` mount and checks it on `issueLink`/`revokeLink` only; link-file routes
check the mount and the current owner chain; resend and verification have durable progress across IAM and e-mail.
WU16 — atomic buckets with expiry, admission separate from the submission quota, strict challenge verification, CSP
origins in the approval diff. WU17 — only a completed clean verdict promotes a file (skipped, encrypted, oversize and
timed-out scans never do); quarantined uploads count against the quota; cleanup in every state. WU18 — credential
RPC and failed-login paths, logging coupled to the session change. WU19 — CSV only (XLSX to the backlog), per-cell
formula escaping before quoting, incremental size bounds. WU20 — failure codes only, never an error's name or message;
HSTS on every response, downloads and proxy failures included, on both providers.

## Out of scope (explicit)

- **Declared operations** (`c.read`/`c.update` with `when`/`set`/`inc`): rejected by the owner as too declarative.
  Business logic is TypeScript; only the reach off the road is declared.
- **Row-level security** and any attempt to make data security statically provable: decision 1.
- **An isolated handler host or a platform data executor**: decision 1; the long-term hard boundary in ADR-0012's
  Alternatives.
- **A syntactic detector as the boundary**: destructuring, helper modules and `ctx[k]` evade it. It stays a hint.
- **One literal column catalogue in `schema.generated.ts`**: the file is generated and `codegen --verify` guards it.
- **Deriving zod inputs from rows**: spike A lost bounds and made a migration an API change. `fromRow` covers outputs.
- **File-based routing** (spike C) and **entity sugar** (spike D).
- **`ctx.jobs.enqueue`**: application jobs are cron only and have no queue (WU3 §5).
- **Form inbox reads** and **list writes on the road** (`over` mutations): `unscoped` or `sql` cover them, declared.
  WU15's intake job reads its inbox through a declared `unscoped`.
- **A form with a handler**: a form stays append-only with a constant answer, and a job does the work (WU15's
  decision).
- **A single-use credential in IAM**: a per-use count needs shared proxy state (ADR-0022:105). Single use is
  application state (WU15 §4).
- **A rate counter in the proxy**: the proxy holds no state a decision depends on. The framework keeps the per-client
  bucket (WU16).
- **A scanner service** or a scan outside the application's container (WU17).
- **A framework audit API for applications**: application audit is application tables on the paved road (WU18 §5).
  Durable delivery from Control and Operations to IAM stays in [backlog 71](../backlog/71-deliver-domain-audit-events-durably.md).
- **Outbound e-mail as a declared reach** (`sends: 'email'`): an application sends through `deps`, as plain code.
- **Backup and restore tooling**: database and object-storage backups and restore drills are the operator's.
- **Two-capability access** for `move` and merges ([backlog 97](../backlog/97-the-generated-tests-have-no-move-case.md)).
- **Destructive-migration rules** ([backlog 98](../backlog/98-application-migrations-have-no-destructive-change-rules.md)).
- **A data layer on Cloudflare**: still Bun and Postgres only.
- **Dogfood findings not addressed:** 1 (unpublished packages), 2 (a second app on the local stack: WU11 uses Notes),
  6 (a membership stand-in for the endpoint test), 7 (the seed and `CHECK` columns), 8 (a deploy failing before the
  build gives no reason), 9 (own rows only), 11 (listing members without `members.manage`), 12 (author tests for
  jobs), 13 (`fabrika dev`), 17 (builder and MCP locally), 18 (the template's `bun.lock`), 19 (refusal texts), 20 (the
  checker reads dev scripts: reading less is a place to hide code), 21 (smaller items). WU10 fixes 14–16; WU17 fixes 10
  (listing attachments).
- The 105/106/109 hardening and 107 stay as they are; no unit relaxes them.

## Decisions

Owner decisions, binding (condensed):

1. **Declarative shell, arbitrary code.** The shell is the vocabulary (dimensions, actions, roles), endpoints (kind,
   callers, access form, input/output), jobs, files and webhooks. Business logic is TypeScript. No operation grammar,
   no RLS, no isolated host, no static proof of data security.
2. **The platform protects at the high level:** the proxy admits only authorized calls (ADR-0022); a human approves
   every widening on a protected environment (ADR-0050). What a handler does with data is the code's and the review's.
3. **A paved road with strong guarantees:** the mini-ORM scoped by the endpoint's capability, which reads its own
   target; `expectVersion` and `getForUpdate`; `fromRow`; table scope and action names derived from the vocabulary;
   `.handle()` colocated with the endpoint and sliced off by the reader; no mirrored `implement` tree.
4. **Raw SQL is legitimate**: `ctx.sql`, parametrized, in the endpoint's transaction.
5. **Deviation is a review signal, not a refusal.** Hard refusals stay only for platform integrity: secrets,
   framework internals and `fabrika_*` objects, escaping the schema or the transaction.
6. **Migration SQL**: refuse only escapes; database code becomes a deviation.
7. The 105/106/109 hardening and 107 stay.
8. **The application architecture** is a reference document (WU1); the examples and the CRM follow it.
9. **Agent skills** ship in `@fabrika/app` and are the only text the fresh-agent trial sees (WU10).

Revision decisions (after two independent reviews), binding:

10. **The staged kit lands first** (WU0): vocabulary → tables → kit → groups → contract → `src/app.ts`, public
    signatures with type tests and stubs, so WU2–WU4 implement against fixed signatures.
11. **Off-road reach is declared in the shell** (`sql`, `unscoped`, `connect`, link issuing). The runtime builds each
    handle only for the declaring site and enforces the mode. The declarations are the deviations; Control keeps
    reading only the shell.
12. **`fabrika_*` objects are reserved**: refused in `ctx.sql`, in migrations, in any body, and in `unscoped`.
13. **A function allowlist, not name rules**, for bodies, expressions and `ctx.sql` text.
14. **Backlog 110 is pulled in** (WU12). Until it lands the name rules are defense in depth only.
15. **The transaction is the invocation's** (WU3 §4), with the stated semantics for jobs, webhooks and external effects.
16. **Own-target read hides every column of another action**, in data and type.
17. **The snapshot holds only data-reach deviations**; structure findings are checker hints.

Resolved in this sprint:

- **The catalog check is the runtime witness, not the detector**: Control decides approval from the commit and cannot
  reach the database. It checks the database against the object manifest the migration files declare.
- **Domains stay refused** (WU5 §7).
- **No `ctx.jobs.enqueue`** (WU3 §5).
- **One skill with reference files** (WU10), not several skills.
- **The ADR text follows the code**: ADR-0012 and ADR-0050 once (WU9); ADR-0017 with WU5 and WU12. Until then this
  sprint outranks them (`docs/CLAUDE.md` precedence).
- The idea document is deleted and its still-valid evidence is above.

Platform-gap decisions (owner, 2026-10-12), binding:

18. **The seven gaps of the public intake application are in this sprint** (WU14–WU20), before WU11, with a second,
    private dogfood (WU21) that never enters a public repository.
19. Simple designs: no new service, no complex orchestration. A new reach is a declared deviation and a widening; a
    hard refusal stays only for platform integrity.

Resolved for the gap units:

- **A form runs no handler** (WU15): security and ergonomics, stated there.
- **The per-client bucket lives in the framework**, keyed on the proxy's `X-Fabrika-Client-Ip`; the proxy stays
  stateless (WU16).
- **The scan fails closed on every environment**, and the provider build installs the scanner for any `scan: true`
  collection (WU17).
- **`auth_log` retention is WU18's**, not WU20's: one unit owns IAM.
- **HSTS has no `includeSubDomains`** (WU20): applications share parent domains.

## Sequencing

Each unit runs in its own worktree. Units in one step share no source file beyond the seams named below. Each unit
edits only its own packages' `CLAUDE.md` sections; the integrator merges them. Steps 0–6a's shipped units are in the
[archived first part](../archive/sprint-2026-10-11-paved-road-core.md).

| Step | Units      | Why this order                                                                                                                                |
| ---- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 6a   | WU17       | scan (files, `file-table-sql`, provider-zerops)                                                                                               |
| 6b   | WU15, WU20 | links on WU17's list and scan (contract, jobs, `collections.ts`, IAM) · headers and Operations (`headers.ts`, `dispatch` errors, `report.ts`) |
| 6b'  | WU15b      | after WU15 (the same job and form files), before WU16 (`#form`)                                                                               |
| 6c   | WU16, WU19 | abuse control on WU14's kinds and WU20's header policy · attachment output (`#procedure`, client)                                             |
| 7    | WU10b      | the skill describes what WU14–WU20 and WU15b built                                                                                            |
| 7b   | WU22       | after WU13b's directory; parallel with WU15 — both touch `implement/membership.ts`, the second to merge rebases; before WU11 merges           |
| 8    | WU11, WU21 | the CRM, the counts and both trials · the private intake module; both read only the skill                                                     |

The contract seams (`contract/{build,define,artifact-schema}.ts`, `packages/check/src/reader/`,
`packages/control/src/approval/diff.ts`) are WU17's in 6a, WU15's in 6b, then WU15b's, and shared by WU16 and WU19 in
6c. Each unit adds its own declaration's branch and test file, and the unit that merges second rebases. `dispatch.ts`
is edited by WU20 (`errorResponse`, the spa cases), WU15b and WU16 (`#form`, in that order) and WU19 (`#procedure`);
`jobs/runner.ts` is WU15's, then WU15b's. No other source file is shared within a step: `files/collections.ts` is
WU17's, then WU15's; `proxy-core` is WU20's, then WU16's; IAM is WU15's.

## Run log

<!-- Append as you work: discoveries, deviations, blockers. Graduate each entry:
     changed the *why* → ../decisions/NNNN ; new future work → ../backlog/NN ;
     transient → leave it (dies with the sprint on archive). After graduating,
     trim to a one-line pointer ("→ ADR-0022"). -->

- **WU14 — the proxy decision did not change.** It already treats every row with `requirement: null` alike, so a
  `public-spa` row needed only the kind in `AnonymousEndpointKind`, the proxy manifest parser and the artifact schema;
  no existing row's rules or digest changed. The mount artifact stays `{ kind: 'spa', prefix, dir }`: the row kind
  carries publicness, so the diff sees it on the endpoint (`becomes public` / `for anyone, without signing in`).
- **WU14 — what a public SPA at `/` takes.** It answers every `GET` no more specific row serves and no reserved prefix
  covers, so `GET /app` (no trailing slash) beside a member SPA at `/app/*` now gets the public page instead of 403.
  No row narrows; the new row's widening line is what the approver sees. Public → member classifies as a widening
  (any kind change does), which is conservative.
- **WU14 — `{ public: true, member: true }` passes the types** (an object literal is structurally a `MemberAccess`);
  the build and the reader refuse it. The reader-forms fixture of `differential.test.ts` does not reach `public-spa`
  (shared file, left alone); `packages/check/src/__tests__/public-spa.test.ts` compares reader and runtime for it.
- **WU10 — one skill, eight reference files.** `skill/SKILL.md` plus `references/{app-setup,table-and-migration,
  endpoint,jobs,files,webhooks-links-connectors,tests,errors}.md`: `app-setup.md` (package, tsconfig, contract,
  config, SPA) and `tests.md` (generated tests, seeds, `testKit`) are added to the planned six, because neither had a
  home. `SKILL.md` is 229 lines, not ~120: dprint formats a code block at the markdown width (80), and its one block,
  the tasks slice, is 113 of them. The always-loaded prose is about 110 lines.
- **WU10 — the code blocks are one application.** A task tracker (org → project → task, comments, a report on
  `sql: 'read'`, the member directory, an overdue job, attachments, a webhook, a share link, a connector) that covers the
  probes' stumbling points: a column write action and its own endpoint, `getForUpdate` + `ConflictError` + a seed,
  `over: 'org'` two levels down, dates as days, `fromRow`, `count(*)::int`, `(${v}::text is null or …)`. Every
  `ts`/`sql`/`json` block names its file in the fence; `skill-code.test.ts` compiles them with the skill's own
  tsconfig from `examples/zerops-app/.skill-app/` (so the template's packages resolve), classifies the migrations,
  holds `package.json` to the template's dependencies and the file table to `fileTableSql`, and on Postgres migrates
  them to `src/__tests__/skill-app/catalog.json`, from which the generated schema is rendered (equal to real
  codegen). Materialized, the application passes the whole loop on main + WU13b: tsc clean, `fabrika-check` 0
  refusals and 0 hints, 62 tests (generated included), the SPA build. After the rebase onto WU13b the test needs no allowance.
- **WU10 — what the trial app taught the skill.** An edit endpoint with only optional fields fails its generated
  cases (the sample sends none, and an empty update is a 500), so the skill's edit takes its fields as required. A
  webhook's generated `bind` needs a fixture. Share links, `creates` and member management still fail the generated
  endpoint test (dogfood finding 6): the skill says so under "Not built yet" and asks first.
- **WU10 — readers.** `@fabrika/app/agent-skill`: `AppAgentSkill` gains `version` and `references` (`{ path, topic,
  text }`), plus `readAppAgentSkillAt(skillDir)` and `installedAppAgentSkill(appRoot)` (the nearest
  `node_modules/@fabrika/app/skill`). The builder installs every file from the application's pinned package, else
  its own (`InjectResult.appSkill: { from: 'application' | 'builder', version }`). `get_app_rules` takes
  `{ topic?, workspaceId? }`, heads its answer `fabrika-app <version>`, and warns when the workspace's `package.json`
  range does not admit it. `renderAgentsFile` renders the body and every reference. Outside the listed touch points:
  `scripts/release.ts` (`stagedSkill`: the packed `SKILL.md` carries the released version, since the source version
  is not bumped) and `docs/reference/mcp-authoring.md`.
- **WU10 — dogfood findings 14–16:** `admin` is reserved (`table-and-migration.md`, and a type error since WU13b);
  `fileTableSql` takes `{ column, type }` for its key and chain, with the command and its output (`files.md`, the
  test holds the two equal); the seed's limits (text markers break a `CHECK`, use an `ENUM`; a required foreign key
  outside the chain) in `tests.md`. The name rules are stated as defense in depth with the runtime role as the
  boundary (WU12 landed), so the skill has no "until WU12".
- **WU10 review round 1.** (1) The release staged every `skill/SKILL.md` and threw on the builder's, which has no
  version: only `@fabrika/app`'s skill is staged (`stagePackage`, `stagedAppSkill`), and the whole public set is
  staged in a witness. (2) **Raw SQL is sound by construction:** `${ctx.sql.scope(capability, table, alias?)}`
  (`packages/db/src/sql.ts`, `scopeTerms` in `store.ts`) renders the capability's whole predicate as bound values — a
  `Ref`'s object and every chain link, a `Within`'s values and container grants, `(true)` for `all`, `(false)` when
  empty — and refuses a table it does not reach; the fragment is a private class bound to its site, the one
  interpolation that is not a single parameter. The access fixture's reports written with it pass the in+sql leak
  case, and the skill shows it as the way to scope a statement. (3) The staged reference files' `@fabrika/*` ranges
  are the released version. (5) `testKit` answers a member directory from its own callers when no `membership` is
  given (`testing/directory.ts`); a contract that writes through IAM still gets none, so `boot` still names the
  transport. (4, 6–10) The skill states the connector CLI's Control credentials, the webhook's 30-day replay window
  and crash gap, connector outcomes as no HTTP answer, sums' types and nulls, the `HttpError` statuses, and the
  versioned and unversioned write answers.
- **WU10 review round 2.** (1) A fragment is a frozen object without a prototype, registered in a module-private
  `WeakMap` read through methods bound at load: replacing a static, forging an object or patching `WeakMap.prototype`
  no longer passes one, and a fragment of another site (live or ended) is refused. (2) Every interpolation's place is
  checked in the original text before any fragment is spliced, so `(true)`/`(false)` fragments with no value are
  refused inside a literal, a quoted name, a dollar body and both comment forms. (3) Placement is enforced: a fragment
  stands alone, joined by AND, at the top level of a WHERE or JOIN … ON clause with no top-level OR or BETWEEN; the
  access fixture's ORed report is refused and leaks nothing, its parenthesized twin passes the leak case. (4–7) The
  skill exempts reference tables, names the capability per access form and for jobs (`tx.sql.scope`), states the
  structural error contract, the fragment as the one SQL interpolation, and labels for `members.manage` holders.
- **WU18 — durable audit.** The SQL port has only `batch`, so a change's record is a statement in the change's own
  batch (`auditEventStatement`), and a guarded change records itself through `INSERT … SELECT … WHERE` behind a
  row-locking no-op UPDATE; without the lock two concurrent Postgres revokes wrote two rows. Deviations: a member
  revoke writes one `iam.member.revoke` row per role removed (`metadata.role`, was `roles`), because the creator role
  and the others are one batch now; an invitation whose email fails is deleted with an `iam.member.uninvite` row
  (`reason: 'delivery_failed'`); a password action records `{ delivery }` at issue and a failed email as its own
  `iam.password.<purpose>.delivery_failed` row; disabling a disabled principal, revoking a revoked share link or
  session records nothing. `auth_log` gains the `logout` kind and `privileged` (migration 0008 rebuilds the table on
  SQLite). Mint rows stay in `waitUntil` (not logins). `iam-contract`'s `AuthLogDto` gained `kind: 'logout'` and
  `privileged`, outside the touch points. Discovery: concurrent statements on the connection the IAM test fixture
  migrated with hang in Bun SQL; a fresh pool does not, so `durable-audit.test.ts` runs on a pool of its own.
- **WU18 review round 1.** A guarded change's record no longer rests on an existence check behind a row lock: other
  writers (an admin grant beside a membership one, a login beside a bulk revoke) took no such lock. `AuditWriter`
  writes the record from what the change itself changed — one `WITH c AS (… RETURNING) INSERT … WHERE EXISTS` statement
  on Postgres, `changes()` right after the change on SQLite/D1, whose writers are serialized; the composition passes
  the dialect. OIDC principal create, claim and refresh, password completion and rehash, the forgot-password bootstrap
  principal and a workload's first principal now commit with their record; bulk revocations that change nothing record
  nothing; audit rows label a user by its id and carry no address; every terminal login refusal is logged with a fixed
  reason. Five Postgres suites built the SQLite composition over Postgres and now use `createPostgresIamRepositories`.
- **WU18 review round 2.** A public recovery issues its token (and a bootstrap admin's enrollment opt-in) with its
  record in one batch; a handoff redemption writes its `allow` row in the child session's batch and opens nothing when
  that write fails; an oversized or cross-origin password form is a logged refusal; an admin's 404/405 REST request is
  recorded (`/admin/*` or its template). The write-path sweep found OAuth consent and grant revocation unaudited; they
  now record `iam.oauth.grant.create` / `iam.oauth.grant.revoke` in their own batch.
- **WU18 — the Bun SQL hang, diagnosed.** Under concurrency a Postgres `batch` (`sql.begin`) holds a pooled connection
  idle in its transaction while pool queries queue behind it, so a burst larger than the pool hangs; the round-1 note
  blamed the migration connection. `AuditWriter.run` now sends a single audited statement (always the case on Postgres)
  without a transaction, which is atomic alone. Batches elsewhere keep the hazard; it predates this unit.
- **WU20 — failure codes, not names (review item 7).** A 5xx reports `framework_fault`, `unavailable`,
  `capability_refused`, `query_refused`, `handler_status` or `handler_failed`, never the error's name or message. The
  server log line (the record without a DSN) is the code plus the text of a framework refusal; it no longer prints an
  unknown error's name, which any thrown value sets.
- **WU20 — one reporter per boot.** `operationsSettings` reads the DSN once in `boot`; jobs and requests get their own
  envelope `logger` (`fabrika.jobs`, `fabrika.requests`). A DSN that is not an ingest DSN now stops every boot, not only
  one with jobs. `JobReport`/`JobReporter` are renamed `OperationsReport`/`OperationsReporter` (`runner.ts`: a merge
  note for WU15). The delivery is not awaited: `ContractApp.fetch(request, exec?)` hands it to a Worker's `waitUntil`.
- **WU20 — HSTS lives in the proxy only.** The framework has no public scheme, so its in-process policy stays without
  it; `appHeaderPolicy`/`appFileTreatment` add it from the manifest. Caddy's own 502 (an upstream it cannot dial)
  carried no header at all before; the server's `errors` routes now give it the host's policy. Installation hosts
  (IAM, Control) are out of scope: their answers pass through, and a proxy denial there carries the base policy
  without HSTS.
- **WU20 — the SDK witness is the Notes example.** The local stack builds the example's SPA on every prepare (it was
  never built, so `/` answered no file); the browser identity's notes grant replaced the witness grant
  (`packages/iam/src/node/browser-identity.ts`, one line). The scenario throws an uncaught error whose function name
  carries the run marker, because the SPA sets no SDK fingerprint and the grouping is by type and frames.
- **WU20 review round 1.** Framework refusal messages can quote request data, so `QueryRefusedError`,
  `CapabilityRefusedError` and `ServerFault` take a `reason` from a closed catalog (`QUERY_REFUSALS` in `@fabrika/db`,
  `CAPABILITY_REFUSALS`, `SERVER_FAULTS`), and the log line prints the code, the reason and its fixed text only
  (`query_refused: sql_read_only: sql: 'read' runs queries only; …`); the message stays on the error for the author's
  own run. Every throw site in `@fabrika/db` (123) and the app (39) names a reason. Early proxy refusals carry the named
  host's transport header; the Cloudflare Worker's initialization 503 the named host's treatment; an application's own
  HSTS is dropped on `http` (Caddy deletes it only on `http`, because a named delete runs after the set). The followed
  agent-change commit's SPA is built before Notes serves it; the SDK scenario passes after that follow, without a reset.
- **WU20 review round 2.** The sweep of runtime log sinks found two more: a file cleanup and sweep logged a storage
  error's name, and a failed webhook delivery logged the unsigned `X-GitHub-Delivery`. Both now log fixed codes (the
  failed step; `delivery_failed`), and `deliveryIdOf` is gone. Every other `console.*` and reporter call in the app and
  db runtime interpolates only declared names, fixed codes or closed IAM outcomes.
- **WU17 — file malware quarantine.** ClamAV was measured locally only (`clamav/clamav:1.4`): one `clamscan` over 21
  files took 11 s and peaked at 0.99 GB resident, so a scanning contract's deploy service needs `minRam: 2`
  (`ZEROPS_SCAN_MIN_RAM_GB`); the Zerops facts stay UNVERIFIED in `docs/reference/zerops-platform.md`. Deviations:
  `freshclam` also runs in `initCommands` (an image's signatures are as old as its build, and the scanner refuses
  ones older than three days); `ALTER TABLE fabrika_files_*` was refused everywhere, so `fileScanSql` and its exact
  classifier exemption exist; `scan` is in the artifact only when true, so other digests stay; every file collection
  gains `files.<name>.list`; the local stack's `notes` service runs `app-image/` (not started, only built).
- **WU17 review rounds 1–2.** ClamAV answers OK for an LZMA entry, a damaged deflate stream and a ZIP after a prefix
  whose entry sizes are in a data descriptor, so the framework checks archives itself and fails closed: a ZIP-based
  type starts at offset 0, any other file holding a ZIP signature is rejected (about once per 1400 MB of random
  binary data, accepted), and the end record must be unique and end the file. A download reads only the scanned
  version (`If-Match` on the recorded ETag); object keys are written once. A file without a verdict, or whose delete
  failed, waits with backoff and is retried alone; the batch takes the oldest due files across collections. An empty
  upload to a scanning collection is refused (400 `empty`) rather than promoted without a verdict.
- **WU22 — generated cases of a nested list.** A generated case grants the endpoint's action at the table's grant
  dimension (a deal's company). IAM checks a list on the directory's value (the org), so the case of a deal endpoint
  of `crm.read` was refused 403. The endpoint access kit now grants such an endpoint's action on the directory's value
  instead: still one scope per side, so isolation is still what the case tests.
- **WU22 — `client-identity` refuses `ownerId`.** The checker reads `ownerId`, `userId` and their kin as the caller's
  own identity, so a picked person's field is named by its role (`assignee`, `newOwner`); the skill says so. WU11: the
  CRM's `deals.assign` field must follow when it adopts the lookup.
- **WU22 — deviations.** Control now issues the Zerops membership key for every contract with an endpoint on, in or
  below a dimension with members (it did only for a `members.list` endpoint): a deploy of such an existing contract
  gains the key. On Cloudflare a binding without `findMember` is still a membership transport; only a lookup answers
  503. Jobs get no lookup: a job holds no object chain. `implement-mistakes/11` now assigns instead of listing,
  because a note endpoint reads its workspace's directory. Outside the touch points: `packages/local-stack` gained
  `@fabrika/db` (dev) for its Postgres witness, and `dprint.json` excludes the fixture's generated tests.
- **WU22 — one process, one binding.** The root `bun test` runs every file in one process, and a data layer binds
  once. The fixture's `src/app.ts` is booted by its own generated tests, so every other suite over the fixture boots
  `serve(contract, { database: scoped(tables) })` of its own.
- **WU22 review round 1.** (1) `findMember` trusted the application's chain and action: a grant on a note with a
  substituted parent, or the global creation action, found a member of another workspace. IAM now derives the
  authority itself: the action must be one of the dimension's reconciled `lookups`, held on the directory's value
  (the coarse rule; IAM holds no containment below a value), and the input names no chain. A lookup from a caller who
  holds the action only on a company is now 403, as a list was; the endpoint access kit grants every directory
  endpoint's case its action on the directory's value. (2) The reach is recorded in the artifact (`directories`), so
  the digest covers it and a baseline without it widens. (3) A generated member's id and label are the other side's
  markers, so `kit.leaked` catches a cross-org member in an answer. After the rebase onto WU20, the new throw sites
  name `facility_unbound`, `directory_unlocated` (new) and `iam_answer_mismatch` (a lookup answered for another id).
- **WU11 — the CRM** (`examples/crm`, in `test:examples`): the dogfood surface in six slices (orgs, companies,
  contacts, deals, tasks, activities), the attachments of a deal, the hourly `overdue` job and the SPA through the plugin
  (`web/__tests__/bundle.test.ts`: no handler code, no server module). Added: `deals.reopen` and a closed-deal rule for
  `move`, both under `getForUpdate` (seeds `api.deals.move: lead`, `api.deals.reopen: won`; two concurrent reopens give
  200 and 409); `deals.source`; the deal owner as the column write action `deals.assign`; `orgs.members` on the
  `crm.read` directory (`directory: 'labels'`) for the owner and assignee pickers; `deals.pipeline` on `sql: 'read'`
  with `ctx.sql.scope(ctx.within, 'deals', 'd')` (every stage in order, empty ones included: an `unnest` of the stages
  left-joined to the scoped deals). Lists are keyset pages; mutations answer `Saved`; `remove` takes `expectVersion`.
  `fabrika-check`: 0 refusals, 0 hints. 154 tests on Postgres (131 generated, 23 authored).
- **WU11 — counts** (raw `wc -l`, the baseline's file classes; dogfood at `204b8f6`):

  | Class                                                                         | Baseline (10 files) |                 CRM (14 files) |
  | ----------------------------------------------------------------------------- | ------------------: | -----------------------------: |
  | shell + handlers + data access (contract, `app.ts`, `database.ts`, stores)    |                 440 |                            319 |
  | — of it: vocabulary · schemas · contract · endpoints · logic · kit · `app.ts` |                   — | 30 · 24 · 29 · 221 · 4 · 5 · 6 |
  | `src/db/tables.ts`                                                            |                  59 |                             51 |
  | `fabrika.config.ts`                                                           |                  39 |                             29 |
  | **hand-written server lines**                                                 |             **538** |                **399** (−26 %) |
  | migrations                                                                    |                 115 |                            117 |
  | authored tests (+ fixtures)                                                   |                 236 |                      349 (+ 2) |

  Pass: 399 ≤ 400 with 28 RPC endpoints (34 endpoints in all: 4 file endpoints, the SPA, the health check) against the baseline's 25 RPC endpoints, and no file that only mirrors another (the
  handler tree, `database.ts` and the stores are gone). 383 lines without comments and blank lines. The margin is thin:
  the 400 needed cutting restating comments, one-line schemas through a shared `MaybeText`, and destructuring edit
  inputs (`({ input: { expectVersion, ...contact } })`: a handler's input omits the access form's `from` field, so the
  rest is the column set). The 7 list handlers repeat one 2-line page mapping (`items`/`next` through `fromRow`); a
  `fromPage` beside `fromRow` would save 14 lines (not added: framework API and the skill, out of WU11).
- **WU11 — bug found: the seed sampled a `date` as a full ISO timestamp** (`packages/db/src/testing.ts` `sampleOf`),
  and the policy probe inserts it through the layer, which takes a day only as `YYYY-MM-DD` since WU13a: a table with a
  required insertable `date` failed its generated insert case with a 500. Fixed in the seed; the CRM's `tasks.due_on`
  is the witness.
- **WU11 — deviation trial on the CRM.** Branch `wu/pr11-crm-deviation` (not for merge), commit pair `332170ab` →
  `089ac8f3`: an `auditor` role (`crm.audit`, a global grant) with `admin.stageChanges` (`unscoped: {
  deal_stage_changes: 'read' }`) and `admin.pipelines` (`sql: 'read'`, `unscoped: { deals: 'read' }`), and a migration
  with a plpgsql `AFTER UPDATE OF stage` trigger on `deals` writing `deal_stage_changes`. Nothing refused: tsc clean,
  `fabrika-check` 0/0, 162 tests. `readAccessSnapshot` + `classifyAccess` over the pair: `widening`, 11 lines, 5 of them
  closer review — `api.admin.pipelines` declares raw SQL (`read`), declares table `deals` unscoped (`read`);
  `api.admin.stageChanges` declares table `deal_stage_changes` unscoped (`read`); the migration declares function
  `deals_record_stage_change` and trigger `deals.deals_record_stage_change`. `snapshotDeviations` of the head also names
  `api.deals.pipeline`'s raw SQL, the base's one deviation.
- **WU11 — `ctx.sql` without the declaration** (`sql: 'read'` dropped from `deals.pipeline`): tsc names the fix at the
  line (`Unavailable<"ctx.sql needs a declaration: add sql: 'read' (or 'write' on a mutation) to this site">`, and a
  cascade of TS7006 in an authored test that reads the output's type); `fabrika-check` 0 refusals, 2 hints
  `sql-undeclared … (allowed form: sql: 'read' in the options of 'pipeline')`; at runtime the site has no `ctx.sql`,
  the call is a `TypeError`, the request a 500 (log `api.deals.pipeline: TypeError thrown`) and nothing reaches the
  database. The refusal does not name the declaration at runtime; a named throw would be friendlier (not done).
- **WU11 — the parked run on Notes.** The agent change fixture (`fixtures/source/notes-agent-change.patch`, re-pinned to
  `3b293853`) gains `20261010090100_note_titles.sql`, a `BEFORE INSERT OR UPDATE OF title` trigger that trims a note's
  title. On `local:up` the pinned commit deployed and was approved; the change parked on protected `prod` as run
  `01a130d2-eb5b-…` with 7 widening lines, the function and the trigger marked "needs closer review" — agent-browser
  screenshot `notes-parked-closer-review.png` (WU11 scratchpad, `wu11/`). `tests/browser/notes-agent-adds-endpoint-and-table.test.ts`
  expects those lines now (not run: `test:browser`); `local-source-fixtures` tests pass (17, the deployable archive on Postgres).
- **WU11 — the fresh-agent trial's inputs** are `examples/crm/TRIAL.md`: five groups (companies & contacts, deals,
  tasks with the job, activities, orgs and people), a product owner's brief each, the starting copy (checked green for
  groups A and B: 112 and 109 tests) and how a run is judged. Not run here (the integrator's part 3).
- **WU11 — `test:examples` runs each example in its own `bun test` process.** Under `bun test` (with or without
  `--isolate`) a second `Bun.build` with an `onLoad` plugin in one process fails with `EISDIR reading file` on workspace
  sources, whichever example builds second (Bun 1.3.14; two builds in a plain `bun` script pass). Each example's SPA
  bundle test builds once, so one process per example sidesteps it.
- **WU11 review round 1.** (2) The `overdue` job read one page of 500 and reported success with tasks left; it pages
  through every task (100 a page) with the `overdue = false` filter and versioned, fenced writes.
  `src/tasks/__tests__/overdue.test.ts` marks 130 tasks whose first attempt times out once it has committed some (its
  `JobClock` fires the deadline then): the run succeeds on attempt 2, every task is at version 2, and a second run
  changes nothing. A raw-SQL fault trigger was refused by `fabrika-check` in a test (`forbidden-global` for `bun`'s
  `SQL`, `env-read`), so the clock is the only fault an application test can inject. (4) `deals.pipeline` cast each
  sum to `INTEGER`, so two deals of 1.5e9 broke it; the sum stays `bigint`, arrives as text
  (`z.string().regex(…)`) and `safeTotal` (`src/deals/logic.ts`) refuses one past 2^53 − 1 instead of rounding (a
  3e9 case in `deals.test.ts`, the edges in `logic.test.ts`). (3) `TRIAL.md`: a copy is renamed
  `fabrika-example-crm-trial-<group>` (two workspaces of one name stop `bun install`), the SPA's script, build line and
  `web/**/*` include go with it, and group C's contract comment drops the job; checked for C beside `examples/crm`
  (136 tests). (5) 28 RPC endpoints, 34 in all (WU17 added the file list endpoint), not 30. Server lines are 400 (the job's loop and `safeTotal`, with the
  three `remove` handlers on one line each). 157 tests.
- **WU11 — owner/assignee validation waits for WU22.** `deals.assign` and `tasks.create` take the principal and label
  from the input, so an outsider or a forged label persists. No endpoint below the org can check membership:
  `ctx.members` exists only where the action is the org's `members.list` and the access is `on`/`in` the org; on a
  deal it is `Unavailable<"the dimension deal declares no members">`. Framework finding: the paved road has no member
  lookup beside a write capability on a nested scope. WU22 adds it; WU11 then validates the picked principal through it
  and takes the label from the directory.
- **WU11 — owner and assignee validated (on WU22).** `deals.assign` takes `newOwner` and `tasks.create` an `assignee`
  id (the caller when null); `picked` (`src/orgs/logic.ts`) refuses with 400 a principal `ctx.members.get` does not
  find in the deal's org, an unknown id and a disabled member, and the stored label is the directory's (the id when it
  has none), never the input's. Tests: an outsider, an unknown id and a forged label field for both (`crm.test.ts`,
  `deals.test.ts`); the generated cases send a real member through `members` in `endpoint-access.fixtures.ts`. From
  the trial: the overdue job re-reads each task under `getForUpdate` in its transaction and skips one a concurrent
  change closed or marked (opus-c's pattern; the reference failed the attempt with 409). `TRIAL.md` states the run cap
  as 3 tsc and checker runs per group in total, with the failing runs reported beside it.
- **WU11 — counts after review** (same classes as above): 400 hand-written server lines in 15 files (`src/orgs/logic.ts`
  added), 117 migration lines, 469 authored test and fixture lines, 160 tests on Postgres (133 generated). The 400 needed cutting
  the file headers that restated the code; the margin is gone, so the next endpoint on this CRM passes the bar only
  with a `fromPage`-style helper (the 7 list handlers repeat one page mapping).
- **WU11 review round 2.** `TRIAL.md`: every group deletes its removed endpoints' `seeds` and `members` entries (C's
  `members['api.tasks.create']` made `test-scaffold` and the checker fail with `endpoint-fixture`), and E keeps
  `src/orgs/logic.ts`, which the deals and tasks slices import. Checked on WU22 for C (139 tests) and E (143).
- **WU11 part 3 — the fresh-agent trial (integrator).** Six fresh agents saw only the skill and a copy of
  `examples/crm` without one group: Opus on B, C, E; GPT on A, B, D. Against the cap of 3 tsc + checker runs in total:
  gpt-a 3 (1 failing), gpt-b 3 (1), opus-c 2 (0) pass; opus-b 4 (0), gpt-d 6 (0), opus-e 7 (4) do not. A judge found
  no hand-edited generated file, no new role, grant, action or deviation, and the reference tests pass on five; gpt-b
  left out the owner hand-over, because no endpoint below the org could check membership (→ WU22, now merged). The
  cap fails on reruns after test edits (opus-b, gpt-d) and on opus-e probing types through tsc for "the caller's orgs",
  which the skill does not teach. Skill gaps for WU10b: the `over` dimension (four trials chose `over: 'org'`, which
  `classifyAccess` reports as a false widening), `ctx.within.values` and the all-orgs case, `aggregate`'s `sum` and the
  safe-integer limit, a job re-reading its row under `getForUpdate`, the test kit's origin (`https://crm.test`), an
  undeclared route answering 403, the formatter in the loop, a test caller with a global grant or a disabled member.
- **WU16 — anonymous abuse control.** The buckets are fixed per-minute windows of the database clock
  (`fabrika_form_admissions`, framework migration `0003_form_admissions.sql`), each take one upsert whose update runs
  only below the limit, pruning 32 expired rows `for update skip locked`; a row of a past minute is expired by its key.
  Deviations: a form declares `rate: { perClient, perForm }` (the form's ceiling too, because on Zerops the client is
  the balancer and a fixed ceiling would cap every intake); the ceiling is taken only after the input, the honeypot
  and the challenge, so refused requests never empty it (review item 6). The challenge token travels in the input
  field `challengeToken`, which the input must declare (forms take no header the proxy keeps, and the typed page needs
  the field); Turnstile's `action` is the form's mount name and its hostname the request's host. A passed token's digest
  is recorded in `fabrika_form_challenges` for 360 s, so a replay fails whatever the provider says. A refused secret
  (`invalid-input-secret`) is a 503 like an unreachable provider, not the visitor's 400. The provider's fixed origin is
  added to `scriptSrc`/`frameSrc` by `buildArtifact` (the diff shows it); `rate`, `honeypot`, `challenge`, `scriptSrc`
  and `frameSrc` are in the artifact only when declared, so other digests and stored snapshots stay, and the manifest
  parser defaults the two directives for a manifest written before them. An IPv6 client counts by its /64, the
  address is kept as a SHA-256 digest, and a request without `X-Fabrika-Client-Ip` (the test kit) is one `unknown`
  client. Any change of a form's admission widens in the approval diff (a mount change), conservatively.
- **WU16 review round 1.** The form's accepted bucket was taken in its own statement before the insert, so a row
  the database refused (a schema-valid string holding U+0000) consumed the shared quota and the next valid client got
  429. `appendToInbox` now takes from the bucket in the insert's transaction (`InboxQuota`); the per-client bucket stays
  its own statement. Every strict input (procedures, forms, webhooks) and every path parameter refuses a string or key
  holding U+0000 with a 400, because Postgres `text` cannot store it. A declared `frame-src` keeps `'self'`, so removing
  the last frame origin narrows, as the approval diff already says.
- **WU19 — file-download responses.** CSV only, per the binding review; XLSX → [backlog 111](../backlog/111-an-attachment-has-no-xlsx-format.md).
  Deviations: the builder is a standalone `attachment({ … })` of `@fabrika/app/contract`, not `c.attachment`, so a
  schema module (`src/schemas.ts`) and every kit form can declare one, and the reader recognises it like `defineApp`.
  Its value is the rows' array schema, marked, so the handler's types, projection and validation need no new path; the
  artifact row's `output` widens to `OutputShape` (`SchemaShape | AttachmentShape`, auth-core), with ordered `columns`.
  The file carries a UTF-8 byte order mark (Excel reads a BOM-less CSV in the legacy code page) and the header policy,
  not the file treatment: the proxy applies the policy to every procedure row, and it keeps `Content-Type` and
  `Content-Disposition`. A number cell is not formula-escaped (its text is a numeric literal); full-width `＝＋－＠`
  are, beside the review's list. Limits: `maxBytes` ≤ 16 MiB, `maxRows` 10 000 by default and ≤ 100 000, a cell ≤
  32 767 characters.
- **WU19 review round 1.** (1) The row bound ran after projection and validation had copied the whole result; the
  attachment path now checks the count before it reads a row and projects, validates and encodes row by row. (2) The
  byte bound was checked per encoded line, whose width has no column bound; each field is now encoded and counted
  with its separator before the next is read. Witnesses count row and cell reads through a `Proxy`. A result that is
  no list is `output_refused`, as the whole-output validation answered it before.
- **WU15 — verify first.** A job's token carries its actions `scope: null` (app-wide), so it meets `issueLink`'s
  delegation rule on any chain: an issuing job is app-wide for its mount, the link is bound to one object. Measured: a
  revoked link keeps working through a warm proxy cache for at most 270 s (the token's 300 s less the 30 s refresh
  skew, `TOKEN_REFRESH_SKEW_SECONDS`); `visitor-link.test.ts` moves the proxy's clock across that edge.
- **WU15 — how IAM knows a job may issue (review item 1).** `AppWorkloadDef.issues` (auth-core) carries the job's
  approved mount from `schemaFromContract`; the reconcile writes it to `app_workloads.issues` (IAM migration 0010, a
  `CHECK` keeps it job-only), and `appSchemaSchema` refuses a mount the schema lacks or a job without its `issuedBy` and
  grants. `resolveCaller` still refuses every workload; a new `resolveLinkCaller` admits a job for `issueLink` and
  `revokeLink` only, and `membership.ts` reads the declaration at each call; `createLinkCredential` inserts a job's link
  only while the declaration still names the mount. The job presents its token: `WorkloadAuthority` gains `token`.
- **WU15 — deviations.** `@fabrika/iam` gains the dev dependencies `@fabrika/db` and `@fabrika/proxy-core` for the
  end-to-end witness, which boots `@fabrika/app`'s intake fixture against IAM's SQLite harness through proxy-core's
  `Authorizer` (Postgres for the application only). Link-file rows take source `{ kind: 'mount', name: <mount> }` and
  ids `<mount>.files.<name>.{upload,list,download}`, so `#linkTarget`'s mount check applies unchanged; `link: true` is refused
  in the contract (not at boot) when no link mount is bound to the owner's dimension or one does not grant write and
  read. The endpoint test of `ctx.links.revoke` is in `job-links.test.ts`: the multi-tenant fixture is implemented by
  the type-mistake fixtures, which an extra endpoint breaks.
- **WU15 — the intake recipe's crash semantics (review item 3).** The job records each delivery step in the record's
  row before the next effect: revoke a superseded link → record; issue → record the id (`issued`); e-mail → `sent`. A
  stop after any effect is finished by the next run with exactly one live e-mailed link (`intake.test.ts`, one case
  per stop, a refused e-mail and an unreachable IAM): an `issued` row's link is revoked and replaced, an unrecorded
  link's key never left the job. The e-mail is at-least-once; a link's key is never stored.
- **WU15 — link-holder files on WU17.** After the rebase onto WU17 the link holder's list (`<mount>.files.<name>.list`,
  `{ after?, limit? }`, no owner) joins upload and download; quarantine and the held-file quota apply through the shared
  upload and download paths. No scanning link collection is tested here: WU17's suites own the scan.
- **WU15 review round 1.** (1) `createLinkCredential` inserts only while the schema still declares what `issueLink`
  checked (`CheckedLinkDeclaration`: the mount's dimension, grants, `issuedBy`, `maxDays`, the chain's containment, an
  issuing job's actions and `issues`), behind the mount row lock every reconcile takes; a reconcile in between makes the
  issuance `not_allowed` (SQLite tests reconcile right before the write; a Postgres test holds a narrowing reconcile
  open). (2) The intake recipe acts only while its attempt is live (`ctx.signal.throwIfAborted()` before each effect,
  the e-mail takes the signal), and `ctx.links` of an ended attempt asks IAM nothing. (3) Each delivery reserves one
  e-mail of the daily budget before any effect, so failures after the e-mail are counted. The reference states the three
  invariants for WU10b.
- **WU15 — on WU22.** WU22 took IAM migration 0009 (`0009_member_lookups.sql`), so `workload_issues` is `0010` in both
  dialects.
- **WU15 review round 2.** `ctx.links` checked its attempt only before the token lookup it awaits, so an attempt that
  timed out during the lookup still issued or revoked. The check now also runs synchronously right before each IAM call
  (`JobLinkRequest.assertLive`); two regressions hold the lookup past the deadline, one for issue, one for revoke.
- **WU15 — on WU16.** WU16 took `packages/app/src/__tests__/fixtures/intake` for its form-admission fixture, so the
  WU15 recipe lives in `fixtures/visitor-intake`, renamed in every WU15 commit; `fabrika-check`'s differential registry
  reads both.
- **WU15 — on WU19.** WU19 took kit mistake 30, so `job-links-without-issues` is mistake 31.
- **WU15b — verify first.** The serving process already holds every job's key: Control writes
  `FABRIKA_JOB_<NAME>_KEY` into every deploy, `boot` refuses to start without it and binds the jobs in the server too
  (`serveContract` runs `jobs.check()`). A kicked run is `runJob` in that process under the job's own
  `WorkloadCredential` (an IAM exchange per attempt), so it widens nothing; no `fabrika job run` is spawned. A form
  carries no token, so there is no request identity to inherit. Cloudflare: no data layer and no token exchange, so a
  contract with a job does not boot there; the kick still goes to `waitUntil` (30 s past the answer against a 15 min
  job timeout, moot until jobs run on Workers).
- **WU15b — deviations.** The name stays `then`. The compiler check sits on the whole surface (`FormJobs`, an F-bounded
  `S`), so its message is elaborated (kit mistake 32 is in `ELABORATED`). Beside the lease's `pending` flag (framework
  migration `0004_job_kicks.sql`), a kick in flight in one process absorbs the next, so a flood issues one kick per
  process, not one per row; a run takes the flag only after it succeeded, and a failed run leaves it to the schedule.
  `kit.runJob` waits for kicked runs, and `serveContract` drains background work (`createBunHandler`) before it closes
  the database. The witness of a killed run is a subprocess killed inside the kicked run's
  transaction: an in-process `pg_terminate_backend` prints Bun's unhandled release rejection (`@fabrika/db`'s
  connection-loss note). The visitor-intake fixture keeps explicit runs, because its crash tests arm a fault before a
  run and a kick would race them; the witnesses use `fixtures/form-kick`, and WU10b's recipe adds `then`.
- **WU15b — approval.** A form's `then` is a line that widens nothing. It does let anonymous submissions keep the job
  running back to back, bounded by the form's `rate.perForm` and the coalescing: an availability cost, not access.
- **WU15b review round 1.** (1) A kick waited on the lease row while a run's attempt held it as its fence, on a
  connection requests share, so a held write transaction made an unrelated form wait. A kick now takes the lease with
  `tryAcquire` (`for update skip locked`) and keeps its pending flag in its own table, `fabrika_job_kicks` (migration
  0004 rewritten before it shipped), which no attempt locks; a regression holds a run's transaction on a two-connection
  pool while five kicks end and another form answers within 250 ms. (2) The process-local flag scheduled its own
  follow-up beside the shared one (two instances, three submissions, three runs). The shared flag is now the only
  follow-up decision: every run clears it when it starts and takes it after it succeeded, and a local kick in flight
  makes the next one only set it; two instances give two runs. (3) A local follow-up restarted right after a failed
  run; now a failed run leaves the flag for the schedule (`retries: 0`, one run, `pending` kept, the next scheduled run
  takes both rows).
- **WU15b review round 2.** Both races fixed, not documented as a delay. (1) A run that took the flag after it finished
  and then found a newer run holding the lease dropped it, though that run may have read its batch before the kick's
  row: it now sets the flag again and tries the lease once more (`handOver`), as a kick does. (2) A same-process kick
  absorbed by a run past its last pending check was left without a runner: the process-local kick state is gone, and
  every kick asks the lease (`tryAcquire`, flag, `tryAcquire`), a few non-blocking statements each. Regressions hold a
  statement's answer through a delaying dialect (`fixtures/form-kick/delayed-database.ts`). Kicks that straddle a run's
  end can add a run beyond two; at any moment there is still at most one run and one pending, so the 50-submission
  and failed-run witnesses now let the held run's other kicks end before they release it.
- **WU10b — the recipe is its own reference file.** `references/public-intake.md`, not a section of
  `webhooks-links-connectors.md`: an intake has its own vocabulary and tables, and every table needs a policy, so a
  variant over the tasks application could not hold it. `skill-code.test.ts` compiles a `STANDALONE` reference over the
  base's `package.json`, `tsconfig.json` and `src/app-kit.ts` and migrates it to `skill-app/public-intake/catalog.json`.
  Materialized, both skill applications pass the whole loop: tsc, `fabrika-check` 0/0, the generated and authored tests
  (tasks 87 with the files and jobs variants merged, intake 44), the SPA bundles (the portal's holds no server module).
  The recipe follows the fixture's job; it differs where an application's checker differs: `crypto.randomUUID()`
  (`Bun` is refused in a server module) and ENUM delivery states. WU15b's `then` is not on main: the recipe uses the
  cron job and marks the spot (an HTML comment above "The job").
- **WU10b — three framework bugs the recipe's loop found** (`fix(app)` commit): every policy test of an application
  with a form failed (the probe contract lacked the inbox's form, which the compiler requires); the endpoint access
  kit could not boot a form with a challenge (no secret; it now sets a placeholder and refuses tokens locally); a
  `scan: true` collection's generated download case answered 409 (it now runs the scan job with a passing stand-in).
  `testKit`'s `runJob` takes `FILE_SCAN_JOB`. Also found: `defineDeps(build)` runs at the generated tests' boot, which
  sets no variable, so `build` must not require one (the skill says so).
- **WU10b — the trial's gaps** are in the references: `over` names the nearest dimension of the rows' chain (the
  skill's own `mine`, `counts` and the job moved from `org` to `project`), `ctx.within.values` and `'all'`
  (`members.orgs`, a query without input, tested with a global grant), the generated cases' samples and the seed's
  defaults, `aggregate`'s argument and `exactInteger`, the job's re-read under `getForUpdate`, the kit's origin, 403
  for an undeclared path, the formatter and linter, an audited export (`exportProject`, an `in: 'project'` mutation
  with a `project_exports` child row). Open, already in the backlog: labels typed nullable (118), no disabled member
  in the kit (119), no fault injection in a test (117). Not on the road: the log row of an export across a top-level
  dimension (every candidate), which has no table scope a capability writes; the recipe says to ask.
- **WU10b — `fromPage`** (`@fabrika/app`): `fromPage(Schema, page)` is `{ items: page.items.map(fromRow), next }`. The
  CRM's six list handlers use it: 400 → 386 hand-written server lines; 160 tests pass.
- **WU10b review round 1.** (1) The intake job's batch took the first 50 undelivered rows and skipped a spent budget
  only at its reservation, so 50 spent rows starved the rest; the query filters on the budget before its limit, in the
  WU15 fixture and the recipe (`intake.test.ts`: 50 spent rows, then one that gets its link). (2) The skill's overdue
  job re-checks its whole filter under the lock (`isOverdue` in `logic.ts`, with its test); the CRM's needs none, its
  `due_on` is not writable. (3) The policy probe's stand-in forms collided with an inbox form named `probe`; the probe
  now binds `withoutInboxes(tables)` (`@fabrika/db/testing`) and declares no form.
- **WU10b — on WU15b.** Rebased onto `af32c77f`: both catalogs hold `fabrika_job_kicks` (the base's from main, the
  intake's regenerated). The recipe's forms name `then: 'intake'`, the marked spot and the one-minute latency are gone,
  and the schedule is stated as the recovery path. Materialized again on the kick: tsc, `fabrika-check` 0/0, 44 tests.
- **WU10b — a fresh application outside the monorepo** (the integrator's setup with only the skill). The skill had no
  setup before the first table, no first test (the scaffold printed nothing, `bun test` fails with no file), no way to
  install or update itself, and made the SPA mandatory. `references/start.md` is a tableless application of its own
  (compiled by `skill-code.test.ts` without a catalog; materialized: tsc, `fabrika-check` 0/0, 2 tests), with the steps
  to its first table and `fabrika builder init --profile zerops-app --no-daemon --no-open` or `renderAgentsFile` for the
  skill (`init` also creates `.fabrika/` and an empty `tests/`); `fabrika db test-scaffold` now says when it writes no
  test; `app-setup.md` marks the SPA's parts as added with the SPA.
- **WU21 — private dogfood.** A fresh agent built a public intake application (a candidate registration module of one
  of our projects) from locally packed packages and the skill alone. Runs through the wrapper, tsc/checker per endpoint
  group: public 27/6, hr 6/4, consent 4/3, roles 8/3. About 10 more tsc probes ran outside the wrapper. No checker run
  exited 0, because the tarball install's `package-replacement` refusals were always present. 123 tests pass: 86
  generated and 37 authored. Not built: the audited export of every record, which is blocked on the access-form
  question (125, → WU23a). Setup findings fixed by WU10b, which are already above: the tableless start, the first test, the
  skill install, and the optional SPA. Filed → backlog 121–131.
- **WU23a — `ctx.app` is on `ctx`.** The decision named only `ctx.db.app`; the policy probe's `implement` handlers
  need the capability itself, so it is `ctx.app` (`AppCapability`), beside `ctx.target` and `ctx.within`, and
  `ctx.sql.scope(ctx.app, table)` is every row.
- **WU23a — what the generated cases count.** The global case answers `{ answered: true }` unless a 401, a 403 or a
  5xx: the app form refuses with 403 alone, so a 404 is the handler's own answer to a sampled id. The scoped case
  grants the action in the vocabulary's first dimension, or in a scope type `scope` when there is none: any scoped
  grant is refused, so a single-tenant vocabulary without dimensions is covered too.
- **WU23a — scope kept small.** An SPA takes `{ action, app: true }` too (an admin page for global holders); a link
  procedure and an export do not. A job gets no `ctx.db.app`: it reaches application tables through `sql` or
  `unscoped` as before. A membership role that grants an application table's action builds and is harmless (its
  scoped grant never meets the form); no checker hint warns about it.
- **WU23a — fixtures.** `packages/app/src/__tests__/app-wide-fixture/` (positions, the export log, the counts and the
  export of every candidate) with its generated tests committed and excluded from dprint; `app-access.test.ts` runs it
  through the production proxy decision on Postgres. The recipe materialized: tsc, `fabrika-check` 0/0, 69 tests.
- **WU23b — the form's check sits at `appendTo`.** An `Unavailable` on `input` printed the whole zod type; at
  `appendTo` the diagnostic is two short lines. Only `defineTables`' result carries an inbox's columns: the artifact
  form compiles without the check (the runtime's `compileContract` over `scoped(tables).tables`), and `boot`'s
  `inboxProblems` still covers it there; Control's `readContractSource(files)` parses the policies and checks it.
  The artifact itself is unchanged, so no digest moves.
- **WU23b — the skill's applications materialized again.** Base: tsc, `fabrika-check` 0/0, 76 tests, and a probe of the
  two optional filters and the `priorities` lookup (404 for an unknown code). Intake (`full_name`, `received_at`): tsc,
  `fabrika-check` 0/0, 44 tests, and a probe: `{ result: { received: true } }`, a replayed token 400, a camelCase
  field 400, the job drains `full_name` into the candidate's name. The deps entry stays documentation: `testKit` gets
  no `deps` override. Not fixed here: an unscoped `get(id)` of a reference or inbox table still fails at run time
  (`row_address`), and `sql: 'write'` still writes a reference table (a code list an administrator edits is an application table,
  WU23a).
