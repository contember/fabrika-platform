---
id: 278
title: Control notices when IAM or Operations is down
blocked-by: []
---

# 278 — Control notices when IAM or Operations is down

**Summary.** Control's scheduled maintenance probes the health of IAM and Operations and raises an alert when either
stays down. How that alert reaches a person is the open part. Medium.

## Problem

Nothing in the platform watches its own services. During a 90-minute IAM outage on a production installation, the
only signal was the cloud's own failed-start notification, and nobody acknowledged it. IAM has no Operations DSN, and
it failed before any reporter could start. Operations alerts only through its webhook targets, so an Operations
outage cannot alert about itself. Applications' failure reports only reach Operations while it runs.

## Approach / acceptance

1. `runMaintenance` (`packages/control/src/cron.ts`) probes IAM's and Operations' health endpoints over the routes
   Control already uses. A probe failing on several consecutive passes counts as an outage, and so does a health
   answer that says unhealthy. The summary records the probes as counts, never a URL with a credential.
2. An IAM outage becomes an Operations issue, through Control's own report path, with a fixed fingerprint per
   service. The issue resolves on the first healthy pass.
3. An Operations outage cannot go through Operations, so it needs a second channel. Pick one in this item: email via
   [46](46-add-portable-email-alert-delivery.md) over the installation's transport, or a webhook target Control holds
   itself. While neither exists, the outage is at least a `control:` log line the operator's log alerts can match.
4. A probe never blocks the other maintenance steps, and a pass that cannot reach the database still runs it.

Witness: a maintenance test with IAM's health answering 503 for N passes raises one issue, and a healthy pass
resolves it. With Operations unreachable, the fallback channel gets one notice, not one per pass.

## Touch points

`packages/control/src/cron.ts`, `packages/control/src/operations-gateway.ts`, `packages/control/src/iam.ts`,
`packages/operations/src/health.ts` (what its endpoint answers), backlog
[46](46-add-portable-email-alert-delivery.md).

<!-- Origin: the root-cause review of an IAM outage on a production Zerops installation (2026-10). -->
