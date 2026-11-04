---
id: 278
title: The platform notices when IAM or Operations is down
blocked-by: []
---

# 278 — The platform notices when IAM or Operations is down

**Summary.** Operations' active health checks cover IAM, and Control probes Operations itself, so an outage of either
reaches a person. How the Operations outage is delivered is the open part. Medium.

## Problem

Nothing in the platform watches its own services. During a 90-minute IAM outage on a production installation, the
only signal was the cloud's own failed-start notification, and nobody acknowledged it:

- IAM has no Operations DSN, and it failed before any reporter could start.
- Control has no Operations reporter of its own.
- Operations runs active HTTP health checks (`packages/operations/src/health.ts`, `health-service.ts`): failure and
  recovery thresholds, `failed_check` and `recovery` alerts through the webhook outbox. But it runs them only against
  a registered application environment's `publicOrigin`, never against an installation service.
- Operations alerts only through its webhook targets, so an Operations outage cannot alert about itself.

## Approach / acceptance

1. **IAM through Operations.** Platform composition registers IAM's health endpoint (`/healthz`) as an Operations
   health check, beside the application environments, with the default thresholds. An IAM outage then raises
   `failed_check` and resolves with `recovery`, through the targets an operator already configured. Control's console
   origin can be covered the same way.
2. **Operations through Control.** `runMaintenance` (`packages/control/src/cron.ts`) probes Operations' health on each
   pass. Several consecutive failures count as an outage, and the first healthy pass ends it. The notice cannot go
   through Operations. Pick its channel in this item: email via [46](46-add-portable-email-alert-delivery.md) over the
   installation's transport, or a webhook target Control holds itself. While neither exists, the notice is one
   `control:` log line per outage that the operator's log alerts can match.
3. A probe never blocks the other maintenance steps. The summary records the probes as counts, never a URL with a
   credential.

Witness: an Operations health test with IAM's `/healthz` answering 503 past the threshold raises one `failed_check`,
and a healthy answer raises `recovery`. A maintenance test with Operations unreachable for N passes gives one notice,
not one per pass.

## Touch points

`packages/operations/src/health-service.ts` (an installation service as a check), platform composition of the checks,
`packages/control/src/cron.ts`, `packages/control/src/operations-gateway.ts`, backlog
[46](46-add-portable-email-alert-delivery.md).

<!-- Origin: the root-cause review of an IAM outage on a production Zerops installation (2026-10). -->
