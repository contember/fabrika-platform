# Sprint — declare the surface, not the behavior (2026-10-19)

**Goal.** Build the pre-1.0 revision of the contract kinds, now recorded in [ADR-0012](../decisions/0012-fabrika-app-runtime.md) sections 9–16, [ADR-0060](../decisions/0060-a-handler-kicks-a-declared-job-after-its-commit.md), [ADR-0061](../decisions/0061-a-file-is-a-value-in-a-table-column.md) and [ADR-0063](../decisions/0063-a-public-procedure-runs-as-its-own-workload.md) as one breaking
framework minor (0.6), with a platform that still deploys and runs applications on framework 0.5.

**Theme.** The idea document (graduated into those ADRs, in git history) was the spec. Its "Order of work" is the work-unit list below. The success condition is
two deployments on the local stack against the platform at this branch's HEAD: `examples/crm` rewritten on the new API,
and `examples/crm` at tag `v0.5.4` installed from npm, unchanged.

## The two compatibility boundaries (binding for every WU)

[ADR-0062](../decisions/0062-a-platform-release-serves-older-framework-releases.md) and the root `CLAUDE.md` section
"Framework API versus platform protocol".

- **Framework** (`@fabrika/app`, `@fabrika/db`, `@fabrika/ui`, `@fabrika/check` authoring API and rules): break freely.
  Delete the old form, do not keep aliases. Update `examples/*` and tests in the same change.
- **Platform** (Control, IAM, `auth-core`, `proxy-core`, the proxy, Operations, the providers, the `/manifest` wire
  format, `X-Fabrika-*` headers, token claims, the workload key exchange, the IAM schema, `FABRIKA_*` variables, the
  build step): additive only. Everything a 0.5.4 application produces must still be read, approved, compiled, served
  and deployed. A row mode, header, claim or artifact field that 0.5.4 uses stays served. When in doubt whether
  something is protocol, treat it as protocol.
- **The window for the first release under ADR-0062 is 0.4, 0.5 and 0.6.** Every minor of the last six months that
  has a published `@fabrika/check` is in it; `@fabrika/check` was first published at 0.4.0. The intake application pins
  0.4, so a narrower window would force its upgrade. Control reads a 0.4 or 0.5 application with the newest patch of
  that minor (0.4.8, 0.5.5), bundled as an exact npm alias, and upcasts its artifact.
- **PR #11 (form files) is released in 0.5.5.** Its artifact fields, its row-mode extensions and its framework
  migrations (`0005_form_files.sql`, `0006_form_bytes.sql`) are protocol now: the platform keeps serving them inside
  the window, and the framework drains them forward into `fabrika_files` (the idea's "PR #11" section, "if it lands
  first"). Port its streaming multipart parser, its proxy origin check and its byte budget.

## Work units

Each WU follows the matching step of the idea's "Order of work". Every WU:

- Re-verifies the facts it relies on at HEAD before coding.
- Keeps `bun run typecheck`, `bun run lint`, `bun run format:check` and the tests of the packages it touches green
  (heavy runs via `cpu-lease run -n 4 -- …`).
- Adds tests for observable behavior and failure cases, including a 0.5 compatibility test wherever it touches the
  platform side.
- Commits atomically, in Conventional Commits, with the rollout path in the message when it changes generated
  installation files, variables or provider state.
- Appends deviations and open questions to the run log below.

| WU | Idea step | Title                                                                                                        | Main packages                                        |
| -- | --------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| 0  | 0         | ADR-0062 machinery: artifact `format`, per-release readers, upcast, window refusal, build step, compat suite | check, control, provider-zerops, provider-cloudflare |
| 1  | 1         | Workload kind `public`; `ctx.app` / `ctx.db.app` for workloads; `capabilities`                               | auth-core, iam, control, app                         |
| 4  | 4         | `claim`, `queue`, `insert(…, { onConflict })`, a list of actions per table action                            | db, app                                              |
| 2  | 2         | Public procedures, `admission`, `limits`, `http`, `redirect`, `ctx.client`, `kicks`                          | app, check, proxy-core, control, iam                 |
| 3  | 3         | Files as values                                                                                              | app, db, check, proxy-core                           |
| 5  | 5         | Webhook verifiers, `boundTo: 'app'`, `binds`, `put` in webhooks, recoverable replay claim                    | app, check, control                                  |
| 6  | 6         | `egress`, mail attachments and `unsubscribe`, `ctx.url`, signed tokens, `compatibility`, `http.cache`        | app, check, email, control                           |
| 7  | 7         | Delete the old framework forms; the platform keeps their side                                                | app, db, check                                       |
| 8  | 8         | Docs, skill, ADRs, `examples/crm` on the new API                                                             | docs, app skill, examples                            |
| 9  | —         | The CRM on the local stack: new CRM and `v0.5.4` CRM against HEAD                                            | local-stack, examples                                |

## Sequencing

1. WU-0, WU-1 and WU-4 in parallel.
2. WU-2.
3. WU-3 and WU-5 in parallel.
4. WU-6.
5. WU-7, then WU-8.
6. WU-9.

Each WU works in its own worktree on `surface/wu<N>`, branched from `feat/declare-the-surface`. The lead merges it
back and runs `bun run check:ci` on the integration branch.

## Run log

<!-- Append as you work: discoveries, deviations, blockers. -->

- **Source version.** Bun links an `npm:` alias to the workspace when name and version match, so the 0.5 reader alias
  resolved to HEAD while the source was 0.5.4. The branch moves to 0.6.0 first (WU-0); `release-process.md` records the
  rule.
- **WU-4 choices.** `due` may be set on insert, `attempts` never. The backoff is the job's schedule period (60 s if none),
  doubling, capped at 30 days. `claim` needs `limit` (max 500). `queue` is not in the artifact (it changes no access).
  `onConflict: 'update'` runs a second guarded update, not `DO UPDATE`.
- **WU-4 open.** The checker does not verify that `onConflict.columns` is a unique index (Postgres answers 42P10). A row
  past `maxAttempts` has no staff path to requeue it.
- **Merged WU-4, WU-1, WU-0.** WU-0 reads the release from `@fabrika/app` in the root `bun.lock` (the ADR said
  `@fabrika/check`, an optional dev dependency); other lockfiles are refused with a line. The refusal names
  `docs/reference/framework-migrations.md`, which WU-8 writes. The Notes fixture writes a `bun.lock` that names the
  source version.
- **WU-1 choices.** A public procedure's actions live at `declared[<endpoint id>].actions`; WU-2 fills them. Its key
  variable is `FABRIKA_PROCEDURE_<ID>_<8 hex>_KEY` (`FABRIKA_PUBLIC_*` is taken by public build values). IAM refuses a
  schema where an application role grants a public action. Open: refuse a custom IAM policy that grants one; refuse a
  deploy whose namespace proxy pin cannot read a capabilities or public row.
- **0.5.5 was released with PR #11** while the sprint started; the window grows to 0.4 for the intake application
  (above). WU-0b adds the 0.4 reader, moves the 0.5 alias to 0.5.5, and records a v0.4.8 CRM fixture.
- **Merged WU-2** (public procedures, admission, limits on procedures, `http`, `redirect()`, `ctx.client`, kicks).
  `CONTRACT_FORMAT` stays 2; the new artifact fields are absent unless declared, so 0.4/0.5 digests do not change. A
  Zerops deploy whose contract has a public or capabilities row is refused while the namespace proxy pin is another
  source than Control's; contracts without such rows are unaffected. Moved on: `limits` on jobs and webhooks → WU-5;
  the checker rules, the client's redirect handling, `http.cache`, GET mutations, public update/delete → WU-6;
  `bytesPerHour` → WU-3.
- **WU-2 deviations.** Each bucket is charged with its own `take`, not in one admission transaction. The in-flight
  share is a per-process counter (a quarter of `FABRIKA_APP_DATABASE_CONNECTIONS`, default 10). `ctx.client.ip` is
  `null` on Bun and Zerops. The challenge token arrives as the input field `challengeToken`; the Turnstile action is
  the endpoint id with `.` → `_`. Public procedures do not reach record (dimension, child) tables.
- **Open.** Should IAM refuse a custom policy that grants a public action? Should the Zerops pin check compare proxy
  capabilities instead of the exact source?
- **Merged WU-5.** Verifier presets (`github-sha256`, `standard-webhooks`, `stripe`) and `{ hmac }`; `boundTo: 'app'`;
  `binds` on a credentialed mutation; the delivery claim under a lease (migration `0007_webhook_delivery_claims.sql`,
  a row without a lease stays a completed delivery, so 0.5 rows stay replays); `limits` on jobs (`timeout` →
  `limits.timeoutMs`, ceiling 24 h) and webhooks (1 MiB, 10 s / 60 s). Upcast: a 0.5 job's `'5m'` → 300000, `null`
  → 15 min, a webhook → 10 s; fixture `webhooks-0.5.5.json`.
- **WU-5 blocked.** `{ basic }` and `{ bearer }` are refused at build: the proxy strips `Authorization` from anonymous
  rows (ADR-0022 rule 3), so the application never sees the credential. Enabling them is a proxy protocol decision.
- **WU-5 open.** Stripe and Standard Webhooks senders issue their own secret, but `bind` generates it: a set-secret
  operation is missing. Slack and Twilio signatures do not fit `{ hmac }`. Inbound mail with attachments exceeds the
  1 MiB webhook ceiling. `put` in webhooks waits for WU-3.
- **Merged WU-3.** `0008_files.sql` creates `fabrika_files` and `fabrika_file_deletions`, copies each collection's held
  rows as legacy files, moves a form's held files, and adds `fabrika_files_release`; no released migration or table is
  changed or dropped. File columns, staging, `put`/`open`, the deletion protocol, file outputs with the derived GET,
  the client's codec, `url()`/`download()`, the `file-column-migration` checker rule, approval lines, `bytesPerHour`
  (charged from the declared Content-Length, or the whole body limit without one), and `put`/`open` in webhooks.
- **WU-3 notes.** `bytesPerHour` and the procedure buckets reuse the form admission tables (`fabrika_form_bytes`, the
  per-minute table): WU-7 keeps or moves them. The ClamAV suites were not run. Mail attachments moved to WU-6.
- **Merged WU-6.** Signed tokens (`FABRIKA_TOKEN_KEYS`, Control migration `0012_token_keys`, `rotateTokenKey`), GET
  mutations, token-carried redirect targets and public update/delete, `ctx.url` on `FABRIKA_APP_ORIGIN`, one-click
  unsubscribe, mail attachments (only `live` files, `maxAttachmentBytes` per transport), `egress` with a fetch guard
  and the `cross-app-fetch` rule, `compatibility: 'backward'`, `http.cache`, the client's `redirect()` answer, the
  `on-conflict-index` and `url-endpoint` rules. `check:ci` green on the integration branch after the merge.
- **WU-6 deviations.** Token purposes are declared in `defineApp(…, { tokens })`, not `c.token` in the contract.
  Cloudflare refuses a non-null `FABRIKA_TOKEN_KEYS` (Worker variables are plain text). A row with `cache` fails
  closed on an older proxy; the Cloudflare proxy Worker must be redeployed first. A dropped `compatibility` promise
  still binds the deploy that drops it.
- **Merged WU-7.** The old forms left the framework (`c.form`, inbox scope, `then`, collections and their generated
  rows, generated webhook bind/unbind, job `scope`); the platform side is unchanged and its approval tests read a real
  0.5 application. `examples/crm` and `examples/zerops-app` keep attachments in a table with a file column, adopted by
  migration. Fixed on the way: the public challenge site key in browser config, `0008` copying rows of deleted owners.
- **Merged WU-7b.** An adoption migration calls `select fabrika_files_copy_legacy('<collection>')` before its INSERT,
  so rows an old instance writes during the rollout do not break it. `crossOrigin` on procedures became
  `admission.origins: 'listed'`; the SPA option `public` became `browserConfig` (the artifact and wire names stay).
  `defineContract` is not a supported authoring form, so it gets no `binds`.
- **Merged WU-8.** ADRs 0012 (sections 9–16), 0019, 0022, 0050, 0060, 0061, 0062 (accepted) rewritten; ADR-0063 new;
  `docs/reference/framework-migrations.md`; reference and skill prose; the idea document deleted; backlog 157 and 171
  deleted, 97, 160, 168 rescoped. Open for review: a 0.5.5 inbox migrated to a table sets a file column to `NULL` for
  rows older than seven days, whose held file the 0.5 sweep may already have deleted.
- **Merged WU-2b.** Zerops refuses a deploy whose rows neither the 0.4.8 nor the 0.5.5 proxy-core parser reads while
  the namespace proxy is pinned to another source; the old parsers are Control dependencies (Zerops process only).
  Open: Control does not record a pin's release, so a pin older than 0.5.3 still breaks on a 0.5 cross-origin field.
- **Merged WU-9.** `bun run local:compat` deploys the unchanged Notes of v0.5.5 and v0.4.8 (npm packages) through the
  local Control, checks boot, proxy rows, refusals and file collections, then deploys HEAD as the next deploy on the
  same data: `0008_files.sql` and the adoption migrations apply, old files download byte-identical, the sweep keeps
  them. `local:smoke` had been red (it did not expect `FABRIKA_SOURCE_MAP_UPLOAD_KEY`); fixed. Not proven: the build
  step over an old release's source. Open points → [backlog 193](../backlog/193-loose-ends-of-the-declared-surface.md).
