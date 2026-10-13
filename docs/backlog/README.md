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
- [36](36-complete-zerops-release-artifact-correlation.md) — Publish Zerops build source maps (release-blocking) and link Delivery runs to Operations evidence.
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
- [97](97-the-generated-tests-have-no-move-case.md) — No access form hands a handler the two `Ref`s a move needs, so the generated tests have no `move` case.
- [98](98-application-migrations-have-no-destructive-change-rules.md) — The checker accepts a dropped column, a rename or a `GRANT` in an application migration; the expand-only rules are not built (the runner already refuses the `GRANT`).
- [99](99-no-check-builds-the-runner-image.md) — No CI job builds or smoke-tests the runner image, and its `bun install` runs without a lockfile.
- [100](100-a-principal-in-many-scopes-gets-no-token.md) — One permission entry per action and scope meets the 8 KiB token bound at a few dozen workspaces; the 1000-value `Within` cap sits behind it.
- [103](103-runs-keeps-an-unused-pending-access-column.md) — Nothing reads or writes `runs.pending_access_json` since contractless applications are refused; a later migration drops it.
- [111](111-an-attachment-has-no-xlsx-format.md) — `attachment()` encodes CSV only; an export with typed cells needs `format: 'xlsx'`, a writer that the WU19 review kept out of the sprint.
- [112](112-an-update-that-sets-no-column-answers-500.md) — An edit endpoint with only optional fields answers 500 to an empty input; its generated cases fail.
- [113](113-the-generated-endpoint-tests-cannot-boot-an-app-that-writes-through-iam.md) — `creates`, member management or a share-link mount stops the whole generated endpoint test from booting.
- [114](114-tests-flake-when-runs-share-one-host.md) — Four suites share a directory, a catalog row or a wall-clock budget with concurrent runs and flake.
- [115](115-a-burst-of-postgres-batches-larger-than-the-pool-hangs.md) — A Bun SQL `batch` holds its connection idle while pool queries queue behind it; a burst larger than the pool hangs.
- [116](116-verify-the-paved-road-zerops-facts-on-a-real-account.md) — Role creation by `db`, ClamAV on a real service, and the pre-WU12 Notes schema need one live sitting.
- [117](117-an-application-test-cannot-inject-a-database-fault.md) — The checker refuses Bun's SQL and `process.env` in tests too; only the job clock can fail an attempt.
- [118](118-member-labels-are-nullable-under-a-labels-directory.md) — `ctx.members` labels are `string | null` even under `directory: 'labels'`.
- [119](119-the-test-kit-cannot-make-a-disabled-member.md) — The kit's directory answers `disabled: false` for everyone.
- [120](120-an-undeclared-ctx-sql-fails-as-a-typeerror.md) — An undeclared `ctx.sql` is a `TypeError` and `handler_failed`, not a refusal that names the declaration.
- [122](122-the-generated-tests-cannot-seed-a-foreign-key-outside-the-chain-or-name-a-child-row.md) — The seed marks a nullable text foreign key, and no fixture names a seeded child row.
- [126](126-a-global-grant-application-has-no-people-of-its-own.md) — Global roles give no member directory and no in-app role management.
- [127](127-a-form-records-no-request-evidence.md) — A form cannot record a client address or user agent as consent evidence.
- [128](128-a-public-page-cannot-read-a-public-configuration-value.md) — A public page has no per-environment public value, such as a challenge site key.
- [129](129-a-job-cannot-remove-a-records-files.md) — An erasure job cannot remove a record's files, and no scheduled sweep runs.
- [130](130-codegen-reports-an-empty-migration-bundle-as-a-connection-failure.md) — `fabrika db codegen` masks "bundle is empty" as a connection failure.
- [131](131-an-application-outside-the-monorepo-cannot-use-locally-packed-packages.md) — No supported install or check of locally packed packages outside the repository.
- [132](132-an-export-of-every-record-needs-the-records-read-action.md) — An audited export of every record takes the records' read action; a separate export permission is a deviation.
- [133](133-a-scoped-endpoint-cannot-read-an-application-table.md) — Only an `app` endpoint reads an application table, so a scoped endpoint cannot validate against an edited code list.
- [134](134-a-sql-scope-fragment-does-not-tie-its-action-to-the-statement.md) — `ctx.sql.scope` checks neither the statement's operation nor, for a `Ref` or `Within`, the table's actions.
- [135](135-deleting-a-zerops-secret-named-like-a-descriptor-variable-is-forbidden.md) — A Zerops secret named like a `run.envVariables` entry can fail to delete with `userDataDeleteForbidden`.
- [136](136-an-unscoped-get-of-a-keyless-table-fails-only-at-run-time.md) — `ctx.db.unscoped.<reference or inbox>.get` type-checks and fails with `row_address`.
- [10](10-app-scope-secrets-on-zerops.md) — Open: how the `app` secret scope is represented across separate Zerops projects.
