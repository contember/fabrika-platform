---
id: 241
title: Verify the Cloudflare email adapter on a live account
blocked-by: []
---

# 241 — Verify the Cloudflare email adapter on a live account

**Summary.** The Cloudflare adapter follows Cloudflare's Email Sending REST API documentation (October 2026) and passes
the conformance kit against a stubbed `fetch` only. Confirm its unverified points on a live account before an
installation relies on it. Small; needs an account on Workers Paid with an onboarded sending domain.

## Problem

`CloudflareEmailSender` (`packages/email/src/cloudflare.ts`) sends through
`POST /client/v4/accounts/{account_id}/email/sending/send` with a bearer API token. It reports `idempotent: false`,
`confirmation: 'sync'`, `listUnsubscribe` and 3 MiB of attachments. The documentation leaves these open, and the
adapter guesses:

- whether a 200 always carries `result.message_id`: the API reference lists it, the REST API guide's example omits it.
  The adapter answers `malformed_response` without it, which over a provider with no idempotency leaves the message to
  a person, so a missing id would park every message;
- the answer for a sender on a domain the account has not onboarded (the REST table has no such code; the Workers
  binding's `E_SENDER_NOT_VERIFIED` suggests one);
- the answer when the account's daily sending limit is spent (the adapter maps every 429 to `rate_limited` and reads
  no code, so it cannot tell the daily quota from a burst limit);
- the answer for an account ID the token cannot reach (the adapter maps a 404 to `provider_unauthorized`; Cloudflare
  may answer 403 instead);
- whether the 5 MiB bound counts the attachments base64 and MIME-wrapped, as the adapter's 3 MiB assumes;
- how the recipient sees the display name, `Reply-To`, both unsubscribe headers and an attachment's media type.

## Approach / acceptance

On an account with Email Sending and an onboarded sending domain:

1. Send a text-only message and an HTML message with an attachment, a reply-to and an unsubscribe URL, and record
   each request and answer and the received message.
2. Provoke each case above: a token without Email Sending Write, another account's ID, a sender on a domain that is not
   onboarded, a suppressed recipient, an oversized message.
3. Correct the adapter's mapping and its tests (`cloudflare.test.ts`, the conformance harness's answers) to the
   recorded answers. Map the daily limit to `quota_exceeded` if its answer can be told apart.
4. Record the confirmed facts in `docs/reference/outbound-email.md` and mark the provider `live` in its table.

## Touch points

`packages/email/src/cloudflare.ts`, `packages/email/src/__tests__/cloudflare*.test.ts`,
`docs/reference/outbound-email.md`.
