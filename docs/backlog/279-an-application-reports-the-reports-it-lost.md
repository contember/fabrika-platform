---
id: 279
title: An application reports how many of its reports were lost
blocked-by: []
---

# 279 — An application reports how many of its reports were lost

**Summary.** When a report to Operations fails even after its one retry, the application counts it and adds the count
to its next delivered report. Operations then shows that an outage hid failures. Small to medium.

## Problem

The reporter (`packages/app/src/jobs/report.ts`) retries a network error, a timeout or a 5xx once. A report that fails
again is one `console.error` line, and the event is gone. A cloud log may file that line as informational, as Zerops
does. On one production installation, a fault in front of the platform proxy failed 10 of 46 reports in 40 minutes,
and nobody learned of it. Operations cannot see a report that never arrives.

## Approach / acceptance

1. The reporter counts reports lost since its last delivery, per process: the count and the time of the first loss.
2. The next delivered report carries the count as a tag, or as its own `ReportsLost` event fingerprinted per
   application and environment, so Operations raises an issue for it. The count resets only once that delivery is
   acknowledged.
3. A process that exits holding a count loses it. The crash path does not wait longer for it (`CRASH_FLUSH_MS`).
4. No report content is kept: the counter holds a number and a time, never a body.

Witness: a reporter test fails three reports, then delivers one. That delivery carries `lost: 3` and the first loss's
time, and the delivery after it carries no count.

## Touch points

`packages/app/src/jobs/report.ts`, `packages/app/src/__tests__/jobs-schedule.test.ts`, Operations' handling of the new
event or tag (`packages/operations/src/ingest.ts`) if it gets one.

<!-- Origin: an Operations ingest fault seen by an application on a production Zerops installation (2026-10). -->
