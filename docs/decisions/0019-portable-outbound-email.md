---
id: 0019
title: Keep outbound email behind one portable service contract
status: accepted
date: 2026-08-04
---

# 0019 — Keep outbound email behind one portable service contract

## Context

IAM needs email for password enrollment and recovery. Operations also needs email notification targets, but that work was deferred because the imported Poplach implementation used a Cloudflare Email Routing binding that has no Bun/Zerops equivalent. Implementing delivery inside either domain would create two provider integrations, two retry classifications, and two places where credentials or message bodies might leak.

`@fabrika/platform` is not the right owner. Its package boundary explicitly forbids opening sockets or performing its own I/O; it contains runtime ports and implementations written only over those ports. Outbound email is already an external service integration. It needs configuration, network I/O, provider error interpretation, and idempotency behavior.

SMTP is not an equal primitive across the supported compositions. A fetch-based provider API is available from both Cloudflare Workers and Bun, but the selected provider must not become vocabulary in IAM or Operations.

## Decision

We will publish a separate `@fabrika/email` package with one runtime-neutral `EmailSender` contract. Domain services own recipients, templates, action tokens, durable outboxes, and retry scheduling. The email package owns message validation, provider request translation, credential-safe errors, and the classification of delivery failures as retryable or permanent.

The first adapter is Resend over `fetch`. The adapter accepts an injected fetch implementation for conformance tests and uses a caller-supplied idempotency key. Its public result and error contracts do not expose Resend response types.

Email availability is an explicit optional service capability. A missing sender never silently drops a message and never changes whether an authentication or notification feature is enabled. The consuming domain must select a defined non-email flow or report that delivery is unavailable.

**Invariant:** Provider credentials, provider response bodies, and email bodies never appear in delivery errors or logs.

## Consequences

- IAM, Operations, and future services can share one provider adapter without sharing domain templates or lifecycle state.
- Adding another HTTP provider does not change IAM or Operations contracts.
- Operations still needs its own notification-target, outbox, retry, and operator-UI work; this decision supplies the transport but does not complete that feature.
- A caller must choose stable idempotency keys and decide how to retry a retryable failure.
- SMTP-only installations need a future adapter or an HTTP mail gateway. SMTP is not emulated through runtime-specific code in IAM.
- Resend is a deploy-time dependency of the first adapter, not a permanent platform contract.

## Alternatives considered

### Put `EmailSender` in `@fabrika/platform`

Rejected because a working sender performs external I/O, while the platform package's established boundary forbids I/O of its own. A type-only port there would split one small capability across packages without removing the provider integration.

### Keep separate IAM and Operations senders

Rejected because both compositions need the same credential handling, validation, idempotency header, and provider error classification. Duplicating those security-sensitive mechanics creates drift without giving either domain useful independence.

### Use SMTP as the common transport

Rejected for the first adapter because it is not an equally supported, operationally simple primitive in Workers and Bun. An HTTP API uses the portable Fetch surface already used throughout the platform.
