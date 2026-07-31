# Operations Errors

Operations accepts Sentry envelopes, groups events into issues, correlates releases and source maps, drives issue triage, and delivers source-scoped alerts. The public ingest protocol and the authenticated operator API are separate surfaces.

## Ingest and grouping

The direct ingest endpoint accepts the Sentry envelope protocol with query or header authentication. It binds the numeric project path to a managed source, limits envelope and event sizes, applies a per-source rate limit, and queues at most 32 events from one request.

Grouping uses an SDK fingerprint when present. The `{{ default }}` token expands to the derived fingerprint. The default fingerprint contains the exception type and the last five in-app frames, falling back to all frames. Line numbers do not split a group. Message-only events use their message value.

Queue consumers resolve a merged issue to its canonical fingerprint before storing the payload or occurrence. They coalesce at most 50 events for one source and effective fingerprint into one issue write while retaining every exact occurrence. Duplicate queue deliveries do not duplicate occurrences, transitions, or notifications.

## Issue lifecycle and read model

Issues support open, resolved, and ignored states; comments; assignment; time and count snooze; resolution in a release; and merge into a canonical issue. A new event reopens a resolved issue as a regression, subject to resolve-in-release semantics. An expired snooze reopens without recording a regression.

Historical occurrences keep their original fingerprint after a merge. Canonical issue counts, trends, and occurrence history aggregate those merged children at read time. List queries support source, status, severity, time window, text, assignee, and recent/new/frequency ordering. All orderings and occurrence history use opaque keyset cursors.

The console polls the active query every five seconds when no mutation or selection is in progress. It provides load-more pagination, 24-hour sparklines, bulk status and same-source merge actions, searchable merge targets, occurrence navigation, all exception causes, source-mapped frames, tags, breadcrumbs, raw event context, and the complete triage controls.

## Alert production and delivery

`new_issue` and `regression` producers run after durable ingest persistence. Spike detection runs every minute and counts exact applied occurrences in the preceding 60 seconds. A spike fires when its count reaches the configured threshold. A source-and-fingerprint claim suppresses repeat spike production for 15 minutes.

Every producer writes the durable notification outbox. It never sends inline. The outbox dedup key prevents duplicate rows when ingest or maintenance retries. Delivery claims use leases, make at most six attempts, and pass the stable dedup key as the webhook `Idempotency-Key`. Webhooks are HTTPS-only, time-bounded, and reject redirects.

Alert settings expose only redacted channel destinations. Operators can inspect source-scoped delivery state and individual attempt timestamps/error codes; payloads and full targets never enter the response.

Webhook is the supported notification channel. Portable email delivery is tracked in [`backlog 46`](../backlog/46-add-portable-email-alert-delivery.md).

## Runtime evidence

Cloudflare and Bun/Postgres compositions use the same domain producers and outbox. Cloudflare Cron Triggers and Zerops `crontab` both invoke maintenance once per minute. SQLite tests cover the complete error workflow. Real Postgres and S3 suites require the `FABRIKA_TEST_POSTGRES_URL` and `FABRIKA_TEST_S3_*` variables; absent variables produce explicit skips rather than simulated coverage.
