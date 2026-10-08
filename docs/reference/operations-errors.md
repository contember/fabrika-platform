# Operations Errors

Operations accepts Sentry envelopes, groups events into issues, correlates releases and source maps, drives issue triage, and delivers source-scoped alerts. The public ingest protocol and the authenticated operator API are separate surfaces.

Operator administration uses `OperationsRpcContract` at private `/api/rpc`, reached by the console through `/operations/api/rpc`. There is no parallel operator REST API; see [core application composition](core-application-composition.md#administrative-rpc-and-protocol-http-surfaces).

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

## Telemetry health

Telemetry health has one rule per source: more than zero archived dead events means `failed`, otherwise `healthy`. Error silence is not evidence of a stalled pipeline, so quiet sources stay `healthy`. A source with no telemetry observation yet shows `unavailable`. Active HTTP checks remain independent of telemetry health.

Dead events are never deleted, so a failed source does not recover. The first `failed` observation produces one `unhealthy_telemetry` alert; later observations produce none. Current state and bounded history are kept per source.

## Runtime evidence

Control's release replay repairs existing frozen contexts when their runs have
become terminal, including contexts whose earlier revision was already applied.
It uses the deployment's app/environment ownership and a fenced conditional
update; it releases ownership before delivering to Operations. A validated matching terminal
context needs no ownership mutation. Discovery scans a captured key range in
100-row pages, so memory is bounded while total scan work grows with retained history.

Repair preserves the original release identity and upload verifier/expiry. It
uses the historical finish time, retains known artifact outcomes, and marks
unfinished available-release artifacts incomplete. Invalid, mismatched or
newly expiry-invalid contexts remain unchanged with a fixed diagnostic. Absent
contexts and exact artifact results that were never persisted cannot be recovered
from current configuration; the required decisions are tracked in
[backlog 95](../backlog/95-close-release-recovery-without-frozen-context.md).

Cloudflare and Bun/Postgres compositions use the same domain producers and outbox. Cloudflare Cron Triggers and Zerops `crontab` both invoke maintenance once per minute. SQLite tests cover the complete error workflow. Real Postgres and S3 suites require the `FABRIKA_TEST_POSTGRES_URL` and `FABRIKA_TEST_S3_*` variables; absent variables produce explicit skips rather than simulated coverage.
