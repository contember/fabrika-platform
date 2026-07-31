# Operations plane

Fabrika owns three parts of an application's lifecycle:

- **Delivery** changes what is running.
- **Access** decides who and what may reach it.
- **Operations** reports what happens after a release reaches production.

The shipped Operations foundation absorbs the useful first slice from Poplach:
error ingestion, grouping, source maps, issue triage, regressions, alerts,
release correlation, and active health checks.

This document explores a broader **Operations** plane. It is a target-state idea,
not a commitment to build every capability below. The initial committed slice is
defined by [ADR-0016](../decisions/0016-independent-operations-plane.md).

## Product shape

The console exposes three equal planes:

| Plane      | Question                                                           |
| ---------- | ------------------------------------------------------------------ |
| Delivery   | What changed, where, and did the change complete?                  |
| Access     | Who or what may act, and what did it do?                           |
| Operations | What is happening in the running system, and what needs attention? |

Operations is deliberately broader than observability. It includes observing a
system, deciding that it needs attention, and recording the response. The
initial Poplach capability appears as **Errors**, not as the whole definition of
the plane.

Possible modules:

- **Errors** — exception ingestion, grouping, event detail, source maps, triage,
  assignment, comments, merge, snooze, regression detection, and alerts.
- **Releases** — release health, introduced and resolved issues, deploy
  correlation, and rollback evidence.
- **Health** — active endpoint checks plus the health of queues, consumers,
  schedulers, and telemetry intake.
- **Logs** — structured application and platform logs searchable by the shared
  operational coordinates.
- **Metrics** — service-level indicators, time-series queries, and dashboards.
- **Traces** — request paths across services and links from an error or log to
  its trace.
- **Alerts** — rules and notification channels shared by every signal.
- **Incidents** — a durable timeline that joins alerts, deploys, audit events,
  comments, mitigations, and resolution.

## Shared operational coordinates

Every signal should use one set of Fabrika-owned coordinates:

```text
application
  └── environment
      └── service
          └── release / deploy run
              ├── error
              ├── log
              ├── metric
              └── trace
```

Cross-signal identifiers such as request id, trace id, runtime instance, region,
and commit should enrich this hierarchy. They must not create a second
authoritative registry of applications or environments.

This enables questions that a standalone error tracker cannot answer reliably:

- Which deploy introduced this regression?
- Did the rollback remove the error and restore the health check?
- Are new errors isolated to one service, version, region, or runtime instance?
- Which logs and trace surround this event?
- Did delivery fail because the provider was unhealthy, or did the deployed
  application fail afterward?
- Which operator changed the issue or incident, and under which authorization?

## System boundary

Operations should be one product plane, not one physical database or one
synchronous request path.

```text
applications ── direct telemetry intake ──► Operations service
                                                   │
Fabrika console ── operator gateway ────────────────┤
                                                   │
Delivery catalog / deploy runs ── private sync ────┤
IAM principals / audit ─────────── private use ────┘
```

The Operations service would:

- own telemetry intake, query, triage, alerting, retention, and background work;
- keep its operational data separate from control and IAM persistence;
- accept high-volume telemetry directly rather than proxying it through control;
- expose the operator surface through the unified Fabrika console;
- reference application, environment, service, deploy-run, and principal ids
  owned by the existing planes;
- use separate storage implementations for signals with different access and
  retention patterns.

Likely storage shapes differ by signal:

- SQL for issue, rule, incident, and other mutable operator state;
- object storage for raw event bodies, source maps, and large payloads;
- an append-oriented indexed store for logs and traces;
- a time-series implementation for metrics and frequency aggregation;
- a job queue for asynchronous ingestion, checks, detection, and notifications.

Cloudflare and Bun/Zerops compositions may choose different concrete stores while
preserving the same domain operations. Portability is a service contract, not a
requirement that every provider use the same database product or query plan.

## Application integration

An application should not need a separately managed Poplach project.
Registration or environment provisioning could create a write-only ingest
credential and inject the endpoint, application id, environment id, and service
id through the selected provider.

The delivery pipeline could then:

1. create or identify a release from the deploy run and commit;
2. upload source maps and other release artefacts over a private authenticated
   path;
3. mark the release deployed when the provider accepts it;
4. let Operations evaluate its subsequent health and regressions.

The application-facing SDK could start with error capture and later add structured
logs or standard telemetry adapters. The wire protocols should be open enough for
existing ecosystem clients where that meaningfully reduces adoption cost.

## Progressive capability ladder

The broad shape should not force a broad first implementation:

1. Absorb Poplach as Errors without losing its existing Sentry-compatible
   behaviour.
2. Replace Poplach projects with Fabrika application/environment/service
   coordinates.
3. Correlate errors, source maps, releases, and deploy runs.
4. Add active service health and portable pipeline-health reporting.
5. Generalize alert rules and notification channels across signals.
6. Add logs, traces, metrics, and incidents only when their storage, retention,
   and operator workflows have concrete requirements.

Each later signal should justify its query model and operating cost independently.
The shared plane must not become a reason to force all telemetry through one
schema or storage engine.

## Open questions

- Beyond the shipped envelope subset, which Sentry ingestion and SDK
  compatibility guarantees are worth preserving?
- Which standard telemetry protocols should be accepted for logs, metrics, and
  traces?
- What are the default retention, sampling, aggregation, and per-application
  quota policies?
- Which notification transports are first-party, and where do their secret
  references live?
- Does incident management belong in Fabrika, or should Operations only supply
  evidence and outbound alerts to another system?
- When does a signal need provider-specific storage rather than a shared
  implementation over the existing platform ports?

The browser and SDK proof for the current Errors slice is recorded in the
[shipped adoption sprint](../archive/sprint-2026-07-31-operations-adoption-proof.md).
Remaining completion work lives in
[Zerops release artifact correlation](../backlog/36-complete-zerops-release-artifact-correlation.md).
