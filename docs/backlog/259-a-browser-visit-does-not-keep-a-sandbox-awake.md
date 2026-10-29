---
id: 259
title: A browser visit does not keep a sandbox awake
blocked-by: []
---

# 259 — A browser visit does not keep a sandbox awake

**Summary.** A request to a parked sandbox's URL wakes it, but nothing counts that as activity, so the next maintenance
pass (every 5 minutes) parks it again and drops its connections. Medium; the documented wake-on-request path is
unusable for more than a few minutes.

## Problem

Box wakes a parked sandbox on a request to its port. The launcher's next request reaches `recordLauncherSeen`
(`packages/control/src/db/dev-sandboxes.ts`), which clears `parked_at` but leaves `activity_at` as it was, more than 30
minutes old. `listIdle` selects the row again and `runDevMaintenance` parks it. Someone who opens the dev URL half an hour
after their last commit sees the application, then loses it within 5 minutes. `docs/reference/mcp-authoring.md` (the
`stopped` state) and ADR-0049 present a request to the URL as a way to wake the sandbox.

## Approach / acceptance

Bump `activity_at` when `recordLauncherSeen` clears a park mark, so a woken sandbox gets a full idle window; a sandbox
that keeps serving requests without commits is then parked again only after 30 quiet minutes, which needs the proxy or
Box to report requests, or the docs to say that browsing alone keeps it awake for one window. A test: park, a launcher
wait after the wake, then a maintenance pass leaves the sandbox running.

## Touch points

`packages/control/src/db/dev-sandboxes.ts`, `packages/control/src/dev/service.ts`, `docs/reference/mcp-authoring.md`,
`packages/control/src/__tests__/dev-sandboxes.test.ts`.

<!-- Origin: the comprehensive review of the per-workspace dev sandboxes PR (#84). -->
