---
id: 186
title: Send email in batches
blocked-by: []
---

# 186 — Send email in batches

**Summary.** Add `sendBatch` to `EmailSender` and let adapters report `maxBatch` above 1, so a bulk send takes fewer
provider requests and less of the provider's rate limit. Medium; decided, not scheduled.

## Problem

`EmailSender.send` carries one message, so every built-in adapter reports `maxBatch: 1`
([ADR-0019](../decisions/0019-portable-outbound-email.md)). Both providers take more per request: Resend's batch
endpoint takes up to 100 messages, and SmartEmailing's bulk endpoint up to 5 tasks. An application that sends to a
whole list from one job run makes one request per recipient, and SmartEmailing's sustained rate (4 requests per
second, after a 2,500-request burst) makes such a run slow.

## Approach / acceptance

1. `sendBatch(messages, signal)` on `EmailSender`, optional or required by capability, answering one result or
   `EmailDeliveryError` per message, so a caller records each row's outcome on its own.
2. Decide how a batch is idempotent. Resend's batch endpoint takes one `Idempotency-Key` per request, not per message
   (<https://resend.com/docs/api-reference/emails/send-batch-emails>),
   so a batch's key must derive from its messages' keys, and a retry must resend the same batch. SmartEmailing has no
   key at all. Verify what a partial failure answers on each provider.
3. `ctx.mail.sendBatch` for a job, with the same key prefix as `send`.
4. The conformance kit covers batches: a batch above `maxBatch` is refused before I/O, and each message's result
   follows the code table.

Witness: the Resend and SmartEmailing adapters pass the batch cases of the conformance kit, and a job that sends 10
messages makes `ceil(10 / maxBatch)` requests.

Batches fit the relay protocol too; design both together if
[backlog 178](178-an-http-mail-relay-protocol-and-a-relay-adapter.md) is taken first.

## Touch points

`packages/email/src/{email,resend,smartemailing,memory,directory,conformance}.ts`, the job context's `ctx.mail` in
`packages/app/src/`, `docs/reference/outbound-email.md`.
