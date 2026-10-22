---
id: 198
title: Verify the Postmark, AhaSend and Lettermint adapters on live accounts
blocked-by: []
---

# 198: Verify the Postmark, AhaSend and Lettermint adapters on live accounts

**Summary.** The three adapters follow their providers' documentation and pass the conformance kit against a stubbed
`fetch` only. Confirm their unverified points on a live account each before an installation relies on one. Small;
blocked on API access.

## Problem

`PostmarkEmailSender`, `AhaSendEmailSender` and `LettermintEmailSender` (`packages/email/src/{postmark,ahasend,
lettermint}.ts`) were built from each provider's API reference in October 2026. The documentation is silent or
contradicts itself on the following, and each adapter guesses:

- **Postmark:** the attachment bound (the adapter allows 6 MiB of bytes under the documented 10 MB message, without
  knowing whether that is 10 MB or 10 MiB, or whether it counts the base64); whether an account still pending approval
  answers 422 (mapped to `provider_rejected`) and not 401.
- **AhaSend:** that the inline subject and bodies are always rendered as MiniJinja, which the documentation implies
  (a 400 for content the template check cannot render) but does not state; if they are not, `literalTemplate` puts
  `{{ '{' }}` into a message that holds `{{`. Also the attachment bound (12 MiB under the 20 MiB message) and whether
  the account ID is always a UUID (the adapter allows `[A-Za-z0-9-]{1,64}`).
- **Lettermint:** where a 409 carries its code. The idempotency guide names `concurrent_idempotent_requests` and
  `invalid_idempotent_request`, the OpenAPI document gives the send endpoint's 409 a body with only a `message`, and an
  older page answers a reused key with 422. The adapter reads `error.code` or a top-level `code`, and maps a 409
  without the in-progress code to `idempotency_conflict`, which is never retried. If the code is absent in practice,
  every in-progress retry stops for a person.

## Approach / acceptance

On an account of each provider with a confirmed sender:

1. Send a text-only, an HTML, an unsubscribe and an attachment message, and record each request and answer.
2. Provoke a wrong token, an unconfirmed sender, a reused key with another body and a concurrent request under one key.
   On AhaSend, send content that holds `{{`, `{%` and `{#`, and check what the recipient gets.
3. Correct each adapter's mapping and its tests (the unit tests and the conformance harness's answers) to the
   recorded answers.
4. Record the confirmed facts in `docs/reference/outbound-email.md` and drop the backlog link there and in
   [ADR-0019](../decisions/0019-portable-outbound-email.md).

## Touch points

`packages/email/src/{postmark,ahasend,lettermint}.ts`, `packages/email/src/__tests__/{postmark,ahasend,lettermint}*.test.ts`,
`docs/reference/outbound-email.md`, `docs/decisions/0019-portable-outbound-email.md`.
