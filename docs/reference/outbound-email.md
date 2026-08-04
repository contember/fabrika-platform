# Outbound email

`@fabrika/email` is the portable outbound-email boundary for Fabrika services.
It runs on both Cloudflare Workers and Bun. The package does not know about IAM,
Operations, templates, action tokens, notification targets, or retry schedules.

## Contract

An `EmailSender` accepts one message with these fields:

- one recipient address;
- subject and plain-text body;
- an optional HTML body;
- a caller-owned idempotency key.

A successful call returns an accepted result with a provider-neutral message ID.
Failures use `EmailDeliveryError`. Its code, retryable flag, and optional HTTP
status let the calling domain decide whether and when to retry. Errors never
include provider credentials, provider response bodies, or message bodies.

The package validates recipient and sender addresses, headers, message content,
and idempotency keys before it starts provider I/O.

## Resend adapter

`ResendEmailSender` is the first adapter. It calls the Resend HTTP API through
the portable Fetch surface. Callers can inject Fetch in tests.

The adapter sends the caller's idempotency key through Resend's idempotency
header and aborts a provider request after ten seconds by default. Network
errors, timeouts, rate limits, concurrent matching requests, server
failures, and malformed success responses are retryable. Other provider 4xx
responses are permanent.

## IAM composition

IAM selects email independently from its authentication methods:

- `EMAIL_PROVIDER=none` or an absent value supplies no sender;
- `EMAIL_PROVIDER=resend` requires `EMAIL_FROM` and the secret `EMAIL_API_KEY`.

Cloudflare materialization maps the public installation variables
`FABRIKA_EMAIL_PROVIDER` and `FABRIKA_EMAIL_FROM` to the runtime values. It maps
the secret `FABRIKA_EMAIL_RESEND_API_KEY` to `EMAIL_API_KEY`. The Bun composition
accepts the same public names and keeps the API key out of non-secret runtime
configuration.

IAM owns its enrollment and reset templates, one-time action state, and delivery
behavior. An installation without a sender uses an explicit manual action-link
flow; it does not silently drop an email. Operations still owns its notification
targets, outbox, retry schedule, and operator interface when email alert delivery
is added.

See [ADR-0019](../decisions/0019-portable-outbound-email.md) for the package
boundary and rejected alternatives.
