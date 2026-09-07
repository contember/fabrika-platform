---
id: queue
kind: technology
title: Cloudflare Queues (async buffering)
slot: null
provides: [message-queue, async-buffering]
requires: [cloudflare]
recommends: [r2, oblaka]
conflicts: []
npm: []
status: stable
sources:
  - where: "developers.cloudflare.com/queues (producer send, consumer queue() handler, batching, retries)"
    read: "Producer .send()/.sendBatch(), the queue(batch, env) consumer handler shape, batch size/retry config."
---

# Cloudflare Queues

## What it is

Managed async message queue to **decouple requests/schedules from slow or bursty
work**. A producer `env.QUEUE.send(msg)` returns fast; a consumer
`queue(batch, env)` processes messages with retries — e.g. write payloads to R2,
or run one bounded background audit while D1 tracks its lease/status.

## When & why to use

- Bursty/spiky ingest (error storms, webhooks) where the request must return immediately (202) and work happens async.
- Batching expensive writes (R2 puts, D1 upserts) instead of doing them per-request.
- Long-running background jobs that need retry and bounded concurrency without
  tying their lifetime to an HTTP `waitUntil`.

## When NOT to use

- Work must complete before the response (synchronous result needed).
- Trivial, low-volume writes — the queue is overhead.

## Impacts & gotchas

- Export a **`queue(batch, env)`** handler from the Worker alongside `fetch`. Check the lopata/RRv7 example for the exact export shape.
- Delivery is **at least once**. Make the consumer idempotent; for long jobs use a
  D1 lease/attempt token and explicit terminal states so a retry cannot run two
  copies or overwrite a newer attempt.
- Handle every message explicitly with `message.ack()` or `message.retry()` and
  catch failures per message. An uncaught exception can retry the whole batch;
  a message with no disposition is retried according to the consumer policy.
- Configure batch size, timeout, retry delay, max retries, concurrency and
  visibility timeout from the real job envelope. A single expensive job often
  wants `maxBatchSize: 1`.
- For ingest, return **202 fast** and let the consumer do R2 + D1. See
  `write-split`. Do not force that batching shape onto one-job-per-message work.

## Relationships — why

- **requires `cloudflare`** — CF binding. **recommends `r2`** (the usual payload sink) and **`oblaka`** (declare producer + consumer).
