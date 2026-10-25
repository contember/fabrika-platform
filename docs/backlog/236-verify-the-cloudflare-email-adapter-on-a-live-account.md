---
id: 236
title: Verify the Cloudflare email adapter on a live account
blocked-by: []
---

# 236 — Verify the Cloudflare email adapter on a live account

**Summary.** The Cloudflare adapter follows Cloudflare's Email Sending REST API documentation (October 2026) and passes
the conformance kit against a stubbed `fetch`; only its accepted answer has been checked live (2026-10-25). Confirm its unverified points on a live account before an
installation relies on it. Small; needs an account on Workers Paid with an onboarded sending domain.

## Problem

`CloudflareEmailSender` (`packages/email/src/cloudflare.ts`) sends through
`POST /client/v4/accounts/{account_id}/email/sending/send` with a bearer API token. It reports `idempotent: false`,
`confirmation: 'sync'`, `listUnsubscribe` and 3 MiB of attachments. The documentation leaves these open, and the
adapter guesses:

- ~~which shape a 200 has~~: verified live on 2026-10-25. A fresh send to one recipient answered 200 with
  `result.message_id` (an angle-bracketed RFC 5322 `Message-ID` on the sender's domain) and the recipient in `queued`.
  The adapter keeps its fallback for a 200 without `message_id` (a delivered or queued recipient accepted under
  `cloudflare:<idempotency key>`) until more answers confirm the field is always there;
- the answer for a sender on a domain the account has not onboarded (the REST table has no such code; the Workers
  binding's `E_SENDER_NOT_VERIFIED` suggests one);
- the answer when the account's daily sending limit is spent (the adapter maps every 429 to `rate_limited` and reads
  no code, so it cannot tell the daily quota from a burst limit);
- the answer for an account ID the token cannot reach (the adapter maps a 404 to `provider_unauthorized`; Cloudflare
  may answer 403 instead);
- whether the 5 MiB bound counts the attachments base64 and MIME-wrapped, as the adapter's 3 MiB assumes, and whether
  the 2,048-byte header value bound counts the unsubscribe URL's `<…>`, as the adapter's 2,046 bytes assumes;
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
