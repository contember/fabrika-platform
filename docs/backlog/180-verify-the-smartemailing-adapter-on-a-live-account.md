---
id: 180
title: Verify the SmartEmailing adapter on a live account
blocked-by: []
---

# 180 — Verify the SmartEmailing adapter on a live account

**Summary.** The SmartEmailing adapter follows the official API v3 document and passes the conformance kit against a
stubbed `fetch` only. Confirm its unverified points on a live account before an installation relies on it. Small;
blocked on API access.

## Problem

`SmartEmailingEmailSender` (`packages/email/src/smartemailing.ts`) sends through
`POST /api/v3/send/transactional-emails-bulk` with HTTP Basic auth, custom `message_contents` and one task per
request. It reports `idempotent: false` and `confirmation: 'queued'`. These facts come from the OpenAPI document
(`https://app.smartemailing.cz/docs/api/v3/openapi.json`). The document is silent on the following, and the adapter
guesses:

- the status code of a forbidden request (the adapter maps 403, like 401, to `provider_unauthorized`);
- the status codes of a server error (mapped to `provider_unavailable` for every 5xx);
- the answer when sending is disabled, which is the default until support sets a rate limit (today any other 4xx is
  `provider_rejected`);
- whether a message without `html_body` is accepted (the adapter omits it when the message has no HTML);
- the format `tag` accepts (the adapter allows `^[A-Za-z0-9_-]{1,64}$`, default `fabrika`);
- the wording of the 429 for the daily limit (the adapter maps every 429 to `rate_limited` and reads no text, so it
  cannot tell the daily quota from the burst limit).

## Approach / acceptance

On an account with sending enabled and a confirmed sender address:

1. Send a text-only and an HTML message, and record each request and answer.
2. Provoke each case above: a wrong key, an unconfirmed sender, a tag outside the pattern, sending disabled, and the
   rate limit if it can be reached safely.
3. Correct the adapter's mapping and its tests (`smartemailing.test.ts`, the conformance harness's answers) to the
   recorded answers. Map the daily limit to `quota_exceeded` if its answer can be told apart.
4. Record the confirmed facts in `docs/reference/outbound-email.md` and drop them from
   [ADR-0019](../decisions/0019-portable-outbound-email.md)'s consequences.

## Touch points

`packages/email/src/smartemailing.ts`, `packages/email/src/__tests__/smartemailing*.test.ts`,
`docs/reference/outbound-email.md`, `docs/decisions/0019-portable-outbound-email.md`.
