---
id: 217
title: Unsubscribes Postmark manages never reach the application
blocked-by: []
---

# 217: Unsubscribes Postmark manages never reach the application

**Summary.** On Postmark's broadcast stream Postmark replaces the message's unsubscribe with its own, and an application
that records consent never learns of it. Medium: an application's consent records drift from the provider's
suppression list.

## Problem

`docs/reference/outbound-email.md` ("Postmark adapter") records what a live account showed: by default Postmark manages
a broadcast stream's unsubscribes. It replaces `List-Unsubscribe` with its own one-click link, appends a footer to the
text and the HTML, and keeps whoever uses either in its suppression list. The application's own link in the body still
works, but an unsubscribe through Postmark's link or footer reaches only Postmark. The next broadcast to that person is
refused (406, `provider_rejected`), and over the relay the application does not even learn that (backlog 194 item 27).

The Schrack CRM withdraws marketing consent on unsubscribe, so its consent records and Postmark's suppression list
drift apart, and nothing tells the operator or the application.

Postmark lets an account set a stream's unsubscribe handling to `None` (the application's own headers and link are
sent unchanged), but only with Postmark support's approval. Nothing in the installation guide tells the operator to ask.

## Approach / acceptance

Two parts, the first independent of the second:

1. **Docs.** The installation guide's mail transport section and `outbound-email.md` tell an operator who chooses
   Postmark for broadcast mail to ask Postmark support for unsubscribe handling `None` on the broadcast stream, and say
   what happens without it.
2. **Delivery of the event.** Carry Postmark's `SubscriptionChange` webhook through Control to the application whose
   message it names, as a provider-neutral event (recipient, stream, suppressed or reactivated, when), so an application
   can update its consent. Decide where it lands in the application (a job input, a webhook the contract declares) and
   how Control maps a Postmark message back to its sender. The other providers' suppression events (Resend, Lettermint)
   take the same shape.

Done when a live Postmark unsubscribe through the footer reaches a test application's handler, and the guide names the
`None` setting.

## Touch points

`packages/email/src/postmark.ts`, `packages/control/src/mail-relay/`, `docs/reference/outbound-email.md`,
`packages/provider-zerops/src/installation/guide.md`, ADR-0019.

<!-- Origin: the Schrack CRM's move to Postmark on v0.8.2 (session crm-8e, 2026-10-23). -->
