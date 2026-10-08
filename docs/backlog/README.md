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
- [57](57-stop-the-caller-choosing-its-own-audit-correlation-id.md) — IAM takes `X-Request-Id` from the caller, unbounded, into `auth_log`; its Worker is edge-routed so the proxy strip never runs.
- [63](63-a-one-click-install-from-the-public-repository.md) — The second install shape: a running platform without creating a repository or a CI system.
- [64](64-close-the-bootstrap-admission-hatch-automatically.md) — A Cloudflare installation comes up admitting on a standing admin list, and closing it is an instruction printed to a human.
- [71](71-deliver-domain-audit-events-durably.md) — Add stable event ids, idempotent IAM acknowledgement and transactional producer outboxes for every domain mutation.
- [79](79-a-namespace-target-cannot-be-changed-after-creation.md) — A namespace's provider target is written once; no API takes a new one, and removing a namespace leaves its Zerops project behind.
- [84](84-a-catalog-projection-can-wait-out-a-dead-flush-holders-lease.md) — Catalog projection windows that remain after the shared lease: four small findings (handoff window, relay run-log line, `markApplied` row count, an unrecorded remote apply).
- [85](85-the-maintenance-replays-outcome-never-reaches-the-service-log.md) — Control's cron replay prints its outcome to a process whose output the platform does not collect; the sync that repairs a stale lease is invisible.
- [86](86-a-cloudflare-deploy-holds-the-account-token-beside-the-repositorys-code.md) — The Cloudflare deploy imports the checkout's config beside the account-wide token and no app owns its resource names there; the review mitigated it, the boundary and the ADR reconciling it with ADR-0005 are still owed.
- [87](87-deleting-a-zerops-app-env-that-holds-claims-answers-500.md) — A Zerops app env's claims restrict its delete, so `deleteApp`/`deleteAppEnv` answer 500 and the proxy republish never runs; releasing the claims needs a decision first.
- [89](89-another-worker-can-still-start-its-own-runner-containers.md) — A real run's container is keyed and its run-naming methods check the instance; another Worker on the account can still start and drive runner containers of its own.
- [91](91-add-an-organizational-directory-to-iam.md) — Add a source-aware organizational-unit tree, access groups, and group role assignments without turning app scopes into a hierarchy.
- [94](94-an-older-iam-schema-can-land-after-a-newer-one.md) — IAM holds one vocabulary per app but runs are serialized per environment, so two environments (or a run recovered late) can leave the older schema in IAM.
- [95](95-close-release-recovery-without-frozen-context.md) — Decide durable release intent, exact artifact evidence and expiry semantics before repairing runs whose original release context is absent.
- [10](10-app-scope-secrets-on-zerops.md) — Open: how the `app` secret scope is represented across separate Zerops projects.
