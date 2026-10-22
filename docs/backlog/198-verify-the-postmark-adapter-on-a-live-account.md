---
id: 198
title: Verify the Postmark adapter on a live account
blocked-by: []
---

# 198: Verify the Postmark adapter on a live account

**Summary.** The Postmark adapter follows Postmark's documentation and passes the conformance kit against a stubbed
`fetch` only. Confirm its unverified points on a live account before an installation relies on it. Small;
blocked on API access.

## Problem

`PostmarkEmailSender` (`packages/email/src/postmark.ts`) was built from Postmark's API reference in October 2026. The
documentation is silent on the following, and the adapter guesses:

- **Postmark:** the attachment bound (the adapter allows 6 MiB of bytes under the documented 10 MB message, without
  knowing whether that is 10 MB or 10 MiB, or whether it counts the base64); whether an account still pending approval
  answers 422 (mapped to `provider_rejected`) and not 401.

The Lettermint and AhaSend adapters, built at the same time, were verified on live accounts on 2026-10-22
([`docs/reference/outbound-email.md`](../reference/outbound-email.md)). Do the same for this one.

## Approach / acceptance

On a Postmark server with a confirmed sender signature:

1. Send a text-only, an HTML, an unsubscribe and an attachment message, and record each request and answer.
2. Provoke a wrong token, an unconfirmed sender and an inactive recipient.
3. Correct the adapter's mapping and its tests (the unit tests and the conformance harness's answers) to the
   recorded answers.
4. Record the confirmed facts in the Postmark section of `docs/reference/outbound-email.md` and mark its row of the
   built-in providers table live.

## Touch points

`packages/email/src/postmark.ts`, `packages/email/src/__tests__/postmark*.test.ts`,
`docs/reference/outbound-email.md`.
