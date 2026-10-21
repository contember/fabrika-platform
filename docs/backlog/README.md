# backlog

Decided work items ("issues") not yet scheduled into a sprint. One self-contained
file per item: `NN-<slug>.md` (zero-padded, **folder-local** sequence — don't
renumber, gaps are fine). Copy [`_template.md`](_template.md).

**No `status:` field** — an item is alive because it lives here. It leaves by being
**deleted** on ship (default; git holds the record) or moved to `../archive/` if it
documents something a future reader needs. Dependencies go in frontmatter:
`blocked-by: [./NN-other.md]`.

Add scope sub-folders (`security/`, `perf/`, …) only once the flat list gets
unwieldy; numbers stay folder-local. A number a deleted item used is retired with
it — the next item takes the next free number, so a link in an archived sprint
never resolves to a different item than the one it meant.

## The phase ladder

Items 01–05 formed the portability ladder. Phases 0–4 are complete. Phase 5 is the live-account
bring-up and release rehearsal in item [05](05-bring-up-on-a-real-zerops-account.md).

## Items

<!-- one line each: NN — short summary (link). Keep it short. -->

- [05](05-bring-up-on-a-real-zerops-account.md) — The light tier is live; what remains is the production two-project shape, custom domains and a full release rehearsal.
- [22](22-unix-second-columns-overflow-in-2038.md) — int4 timestamps; `BIGINT` costs every reader a string. Decide before it is urgent.
- [36](36-complete-zerops-release-artifact-correlation.md) — Prove Zerops build source maps on a real account (release-blocking) and link Delivery runs to Operations evidence.
- [38](38-add-dns-safe-operations-egress.md) — Prevent private-address and DNS-rebinding egress through Operations webhooks and active health checks (release-blocking).
- [46](46-add-portable-email-alert-delivery.md) — Add email alert delivery without coupling the portable Operations outbox to Cloudflare Email Routing.
- [54](54-give-operations-its-own-proxy-app-identity.md) — Half shipped; what is left is moving the operator surface onto the Operations host, which is a console architecture change, not a rename.
- [63](63-a-one-click-install-from-the-public-repository.md) — The second install shape: a running platform without creating a repository or a CI system.
- [64](64-close-the-bootstrap-admission-hatch-automatically.md) — A Cloudflare installation comes up admitting on a standing admin list, and closing it is an instruction printed to a human.
- [71](71-deliver-domain-audit-events-durably.md) — Deliver Control's and Operations' audit events to IAM through transactional outboxes, with stable event ids and an idempotent IAM acknowledgement.
- [84](84-a-catalog-projection-can-wait-out-a-dead-flush-holders-lease.md) — Catalog projection windows that remain after the shared lease: four small findings (handoff window, relay run-log line, `markApplied` row count, an unrecorded remote apply).
- [85](85-the-maintenance-replays-outcome-never-reaches-the-service-log.md) — Control's cron replay prints its outcome to a process whose output the platform does not collect; the sync that repairs a stale lease is invisible.
- [86](86-a-cloudflare-deploy-holds-the-account-token-beside-the-repositorys-code.md) — The Cloudflare deploy imports the checkout's config beside the account-wide token and no app owns its resource names there; the review mitigated it, the boundary and the ADR reconciling it with ADR-0005 are still owed.
- [87](87-deleting-a-zerops-app-env-that-holds-claims-answers-500.md) — A Zerops app env's claims restrict its delete, so `deleteApp`/`deleteAppEnv` answer 500 and the proxy republish never runs; releasing the claims needs a decision first.
- [89](89-another-worker-can-still-start-its-own-runner-containers.md) — A real run's container is keyed and its run-naming methods check the instance; another Worker on the account can still start and drive runner containers of its own.
- [91](91-add-an-organizational-directory-to-iam.md) — Add a source-aware organizational-unit tree, access groups, and group role assignments without turning app scopes into a hierarchy.
- [92](92-an-app-audit-event-takes-its-correlation-id-from-a-caller-cf-ray-on-zerops.md) — `@fabrika/auth` reads `cf-ray` on every composition; on Zerops no edge writes it and the proxy does not strip it, so a caller picks an app audit event's `request_id`.
- [94](94-an-older-iam-schema-can-land-after-a-newer-one.md) — IAM holds one vocabulary per app but runs are serialized per environment, so two environments (or a run recovered late) can leave the older schema in IAM.
- [95](95-close-release-recovery-without-frozen-context.md) — Decide durable release intent, exact artifact evidence and expiry semantics before repairing runs whose original release context is absent.
- [96](96-operations-sees-only-failed-job-runs.md) — Operations ingest takes error events only, so a successful job run, its duration and its start never reach the console; job reports ride the public ingest key.
- [97](97-the-generated-tests-have-no-move-case.md) — The generated tests have no `move` case, though `capabilities` now hands an endpoint the two `Ref`s a move needs.
- [98](98-application-migrations-have-no-destructive-change-rules.md) — The checker accepts a dropped column, a rename or a `GRANT` in an application migration; the expand-only rules are not built (the runner already refuses the `GRANT`).
- [99](99-no-check-builds-the-runner-image.md) — No CI job builds or smoke-tests the runner image, and its `bun install` runs without a lockfile.
- [100](100-a-principal-in-many-scopes-gets-no-token.md) — One permission entry per action and scope meets the 8 KiB token bound at a few dozen workspaces; the 1000-value `Within` cap sits behind it.
- [103](103-runs-keeps-an-unused-pending-access-column.md) — Nothing reads or writes `runs.pending_access_json` since contractless applications are refused; a later migration drops it.
- [116](116-verify-the-paved-road-zerops-facts-on-a-real-account.md) — New roles on an HA service's direct port, ClamAV on a real service, and the pre-WU12 Notes schema need one live sitting.
- [117](117-an-application-test-cannot-inject-a-database-fault.md) — The checker refuses Bun's SQL and `process.env` in tests too; only the job clock can fail an attempt.
- [122](122-a-generated-case-cannot-seed-a-child-rows-state-or-a-row-under-an-in-target.md) — `rows` seeds no child row state and no row under an `in` target; the own case expects exactly 200.
- [135](135-deleting-a-zerops-secret-named-like-a-descriptor-variable-is-forbidden.md) — A Zerops secret named like a `run.envVariables` entry can fail to delete with `userDataDeleteForbidden`.
- [154](154-an-endpoint-reads-its-own-target-only-under-an-action-its-table-names.md) — The skill's "reads its own target, whatever its action" holds only for actions the table names.
- [155](155-creating-a-top-level-value-makes-the-creator-its-member.md) — `creates` makes the creator a member; staff cannot create a value without joining it.
- [159](159-an-application-directory-page-and-an-expired-role-regrant.md) — A 100-person directory page exceeds D1's bind limit; an expired global role cannot be regranted.
- [161](161-app-dev-review-findings.md) — The kit's share links never expire, and an app dev seed error can print a record key.
- [160](160-an-xlsx-text-cell-loses-carriage-returns.md) — An XLSX text cell loses its CR.
- [162](162-the-generated-tests-have-no-column-write-case.md) — A column's own write action is enforced, but no generated policy test proves it.
- [163](163-the-installation-hosts-send-no-hsts.md) — Only an `https` application host gets HSTS; IAM's and Control's hosts get none.
- [164](164-a-job-without-handle-prints-the-builders-type.md) — A job, webhook, link or export procedure without `.handle` prints the builder's type, not a one-line fix.
- [165](165-app-dev-has-no-stand-in-for-an-import.md) — `fabrika app dev` stands in for a form's challenge and an outside HTTP provider, not for a `connect` import.
- [166](166-the-ui-kit-has-no-prop-or-token-for-common-layout-rules.md) — `DataTable`, `PageHeader` and `Checkbox` lack a prop, a wrapped column breaks inside words, and many layout rules read no token.
- [167](167-a-mutations-mutate-is-new-every-render-and-the-screen-test-dom-empties-a-form.md) — `mutate` cannot drive an effect, there is no `useQueries`, and `installDom` makes `Form` submit an empty `FormData`.
- [168](168-the-error-union-drops-the-refusals-type.md) — A failed challenge reads as any 400, and issue codes are dropped.
- [169](169-app-dev-runs-no-cron-job-and-the-stand-in-iam-lists-no-invitation.md) — `app dev` runs cron jobs only from the seed or a `then` kick, and the stand-in IAM lists no open invitation.
- [170](170-a-column-write-scoped-update-cannot-bump-the-version.md) — A raw UPDATE under a column's write action is refused when it also bumps `version`.
- [172](172-a-list-of-values-cannot-show-each-values-last-sign-in.md) — A last sign-in per value needs one call per row and `members.manage`; needs a privacy decision.
- [173](173-the-skills-test-recipes-leak-a-files-globals-and-render-outside-act.md) — The `fetch` stand-in recipe leaks under `--isolate`, and the screen example renders outside `act`.
- [175](175-a-scoped-user-administrator-lists-every-principal.md) — A user administrator scoped to one application still reads the whole directory and anyone's sessions.
- [176](176-the-runtime-does-not-know-the-declared-secret-names.md) — An error report scrubs an application secret only when its variable name says it is one; the platform does not hand the runtime the declared names.
- [178](178-an-installation-transport-through-an-outside-relay.md) — Control's own transport can use only a built-in provider; a `relay` provider over the platform mail wire and a reference relay reach any adapter.
- [179](179-build-a-platform-distribution-that-bundles-extra-email-adapters.md) — Build IAM and Control with extra email adapters as composition inputs; needs another build source, a version lock, and IAM's local-only `EMAIL_SENDER` guard kept.
- [180](180-verify-the-smartemailing-adapter-on-a-live-account.md) — The SmartEmailing adapter is verified only against a stubbed `fetch`; six points of its mapping wait for a live account.
- [185](185-no-release-is-accepted-on-a-live-zerops-account.md) — Run a fresh-install acceptance (namespace, app with a database, one authenticated request, teardown) on a dedicated Zerops account per release.
- [186](186-send-email-in-batches.md) — Every adapter sends one message per call (`maxBatch: 1`); `sendBatch` would cut requests and rate-limit use for bulk sends.
- [187](187-set-or-rotate-the-installation-mail-transport.md) — `fabrika platform mail` sets or rotates the installation's mail transport on IAM and Control and redeploys the environments that use it; today an application gets a change only at its next deploy.
- [188](188-application-mail-review-follow-ups.md) — Application mail review follow-ups: two upgrade release notes, an IAM `delivery_failed` retry, and three `ctx.mail`/`then` runtime edges.
- [189](189-cross-origin-endpoints-review-follow-ups.md) — Cross-origin endpoints review follow-ups: the `http://` host rule, `Vary: Origin` on every answer, a recorded release for a namespace proxy pin, and the preflight's request headers.
- [190](190-the-overview-reads-each-applications-environments-separately.md): The console overview calls Control once per application for its environments; one read for many applications.
- [192](192-a-signed-in-person-cannot-manage-their-own-account.md): No self-service password change or sign-in list; an IAM account page, after rewriting ADR-0020.
- [193](193-loose-ends-of-the-declared-surface.md): The approval of an upgrade to 0.7, admission buckets and other P2s of the surface revision.
- [194](194-mail-relay-follow-ups.md): Mail relay follow-ups: a claim before the dispatcher sends (two double-send paths), maintenance and console edges, the sender's error mapping, expired keys' vault values, no final-failure answer to IAM or an application.
- [197](197-local-compat-has-no-0.7-release.md): `local:compat` deploys no Notes at v0.7.0: its proof needs a release without a file collection.
- [198](198-an-in-container-env-write-may-reach-another-services-credentials.md): Measure whether `zsc` can write a `${host_KEY}` reference that Zerops resolves; if so, a `cheap` namespace's superuser is reachable by its applications.
- [199](199-operations-keeps-every-event-forever.md): Operations prunes nothing; a retention window for occurrences, dead events, observations and raw bodies.
- [200](200-recovering-a-lost-operations-database.md): What Control re-syncs, and what an operator redoes, when the single-node `operationsdb` is lost or restored.
- [201](201-cloudflare-passwords-are-hashed-below-the-owasp-work-factor.md): A Worker caps PBKDF2 at 100 000 iterations; Argon2id through WASM on both runtimes.
- [202](202-relayed-mail-content-is-plaintext-at-rest.md): Control stores relayed mail content, IAM's links included, as plain text until the row is final; seal it under the vault key.
- [203](203-deleting-an-app-or-env-leaves-its-secrets-and-iam-keys.md): An app or env delete leaves its vault rows, its IAM keys and its IAM schema.
- [204](204-a-redelivered-push-webhook-creates-a-second-run.md): A redelivered push creates another run; deduplicate over the signed push.
- [205](205-operations-ingest-robustness.md): An item type echoed into a response header, an unbounded redaction recursion, untruncated frames.
- [206](206-iam-token-and-oidc-hardening.md): The token verifier pins no algorithm; a thrown OIDC fetch skips the refusal path.
- [207](207-three-service-log-lines-skip-redaction.md): Three `console.error` calls print an error's text or object without redaction.
- [208](208-application-framework-and-data-layer-review-follow-ups.md): Six small `@fabrika/app` and `@fabrika/db` findings: two clocks, `bound` insert, `.input()`, prototype methods, insert under `in`, `releaseBytes`.
- [209](209-a-public-procedure-binds-a-token-id-to-its-purpose.md): Any text of any verified token unlocks a row; bind the id to its purpose and table.
- [210](210-platform-review-fix-follow-ups.md): Eleven P3s the reviews of the platform review's fixes left: cost default, console buttons, device bucket, test gaps, run trigger.
- [211](211-zerops-preset-review-follow-ups.md): Minor findings of the Zerops presets review: adoption refusal on republish/update, the backup live row, restore history, hourly on `standard`, the admin hop's request id.
- [212](212-the-console-shows-no-database-backups.md): The console shows no database backups; a provider-owned read of each database's schedule, newest and oldest restore point.
- [213](213-the-cloudflare-application-runtime-is-unverified-on-a-live-account.md): The secrets upload, the object's migration on an existing Worker and a large upload are unverified on a live account.
- [214](214-raw-sql-on-sqlite.md): `ctx.sql` is refused on SQLite: it needs a SQLite lexer, and a Durable Object has no role under it.
- [215](215-file-scanning-on-cloudflare.md): A scanning file kind is refused on Cloudflare: no ClamAV runs in a Worker.
- [216](216-cloudflare-application-runtime-follow-ups.md): Smaller gaps of the Cloudflare application runtime.
- [217](217-postmark-managed-unsubscribes-never-reach-the-application.md): An unsubscribe through Postmark's own link or footer reaches only Postmark; the application's consent records drift.
- [218](218-the-skill-names-no-working-one-click-unsubscribe-target.md): The skill's unsubscribe procedure is POST JSON, which refuses a mailbox's RFC 8058 one-click POST.
- [219](219-a-zerops-platform-deploy-rebuilds-every-service.md): A Zerops platform deploy rebuilds all four services every time, and a bring-up compiles Caddy for 5 min.
- [220](220-operator-traps-of-an-mcp-authoring-bring-up.md): MCP authoring bring-up traps: `put` loses bucket provenance, no `authoring` flag, a bare `forbidden`, `admin` offered for a contract app.
- [223](223-terminal-authority-outlives-the-terminal-in-a-share-link.md): A share link issued on a terminal keeps the terminal's grants after sign-out, release or revoke.
- [224](224-terminal-follow-ups.md): Smaller gaps of terminals: sign-out without `Sec-Fetch-Site`, re-enrolment, sign-out of a personal login.
- [225](225-password-minimum-follow-ups.md): Smaller gaps of the installation's minimum password length: audit, an upper cap, the console page.
- [10](10-app-scope-secrets-on-zerops.md) — Open: how the `app` secret scope is represented across separate Zerops projects.
