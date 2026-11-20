---
id: 289
title: Verify the Brevo email adapter on a live account
blocked-by: []
---

# 289 — Verify the Brevo email adapter on a live account

**Summary.** The Brevo adapter follows Brevo's transactional email API reference and its idempotency guide (November
2026) and passes the conformance kit against a stubbed `fetch` only. Confirm its unverified points on a live account
before an installation relies on it. Small; needs a Brevo account with a verified sender domain.

## Problem

`BrevoEmailSender` (`packages/email/src/brevo.ts`) sends through `POST https://api.brevo.com/v3/smtp/email` with the
`api-key` header. It reports `idempotent: false`, `confirmation: 'sync'`, 10 MiB of attachments, no `listUnsubscribe`
and no `broadcast`. The documentation leaves these open, and the adapter guesses:

- where the idempotency key goes and in which spelling: the idempotency guide puts `idempotencyKey` in the request's
  `headers`, the API reference's example shows `IdempotencyKey` there, and an older changelog says 15 minutes where the
  guide says 30. The adapter sends `headers.idempotencyKey`, a UUID with version 4 bits derived from the message's key;
  whether Brevo checks the UUID's version is not known;
- the HTTP status of a repeated key (`duplicate_parameter`) and of `duplicate_request`, and whether a repeat inside the
  window ever answers the first `messageId` instead of a refusal;
- whether Brevo keeps the key of a request it refused: the adapter retries a 429 or a 402 under the same key, and a key
  kept from the refusal would answer that retry `duplicate_parameter`, which leaves a message never sent to a person;
- whether a text-only request (no `htmlContent`) is accepted: the reference marks `htmlContent` required without a
  template, so the adapter always sends one, rendered from the text when the message has no HTML;
- whether `List-Unsubscribe` and `List-Unsubscribe-Post` in `headers` reach the recipient; the reference says standard
  headers are not supported. If they do, the adapter can take `listUnsubscribe` (and with it decide on `broadcast`);
- the size bound (20 MB per message, and the help center's 4 MB per file) and whether it counts the attachments base64;
- the answer for a key whose account limits API keys to authorised IP addresses (the adapter maps every 401 to
  `provider_unauthorized`), for a sender on an unverified domain, and for an account under validation;
- how the recipient sees the display name, `Reply-To` and an attachment's media type, which Brevo derives from the file
  name.

## Approach / acceptance

On an account with a verified sender domain:

1. Send a text-only message and an HTML message with an attachment and a reply-to, and record each request and answer
   and the received message.
2. Send the same message twice under one key inside the window, and once after it; repeat a key whose first request was
   refused; send a message with unsubscribe headers; provoke a bad key, an unauthorised IP address, an unverified sender, an oversized message.
3. Correct the adapter's mapping, its capabilities and its tests (`brevo.test.ts`, the conformance harness's answers) to
   the recorded answers.
4. Record the confirmed facts in `docs/reference/outbound-email.md` and mark the provider `live` in its table.

## Touch points

`packages/email/src/brevo.ts`, `packages/email/src/__tests__/brevo*.test.ts`, `docs/reference/outbound-email.md`.
