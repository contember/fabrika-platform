---
id: 205
title: Operations ingest robustness
blocked-by: []
---

# 205 — Operations ingest robustness

**Summary.** Three edges of the public error ingest: a caller's item type copied into a response header, a redaction
that recurses without a depth limit, and frames kept untruncated at ingest. Each needs a request signed with a valid
DSN; none leaks data. P3, size S each.

## Problem

1. **An ignored item type goes into a response header.** `parseEventEnvelope` collects each non-`event` item type
   without validation (`packages/operations/src/ingest.ts:96-131`), and the handler joins them into
   `X-Fabrika-Ignored-Sentry-Items` (`packages/operations/src/direct-ingest.ts:159-161`). A type with `\n` or a
   character outside Latin-1 makes `Headers.set` throw. That happens after the events are queued (`:151`), so the
   caller gets a 500 for an accepted event and its SDK retries it. A long type, or many distinct ones, makes a header
   of up to the 200 KiB body.
2. **The redaction recurses without a depth limit.** `redactValue` and `redactRecord`
   (`packages/operations/src/redact.ts:26-43`) recurse once per nesting level. A payload nested about 10 000 levels
   deep overflows the stack inside `buildParsedEvent` (`ingest.ts:158`); the handler's `catch` answers 503
   (`direct-ingest.ts:146-147`), so the SDK retries a request that will never pass.
3. **Frames are stored as sent.** `toParsedException` keeps every frame (`ingest.ts:28-33`); under the 120 KiB message
   limit about 2 600 frames fit. The console's source-map resolution caps the frames and maps it resolves per event;
   the stored event still carries all of them.

## Approach / acceptance

1. Echo only types that match `^[a-z0-9_.-]{1,32}$` and at most a fixed count (for example 16), or drop the header.
   Witness: a `direct-ingest` test with an item type holding `\n` and one holding `č` that answers 202.
2. Stop at depth 64 and refuse the event as `malformed` 400. Witness: a test with a payload nested 10 000 levels that
   answers 400 and records the `malformed` outcome.
3. Optional: keep the last N frames of each exception at ingest, and record that frames were dropped. Decide whether
   the grouping fingerprint (`computeFingerprint`, `ingest.ts:194-200`, which reads the last five in-app frames) reads
   the frames before or after the cut, so an existing issue keeps its group.

No migration, no protocol change: an SDK reads neither the header nor the error body.

## Touch points

`packages/operations/src/ingest.ts`, `packages/operations/src/direct-ingest.ts`, `packages/operations/src/redact.ts`,
`packages/operations/src/__tests__/`.

<!-- Origin: a platform review; the source-map display caps shipped first. -->
