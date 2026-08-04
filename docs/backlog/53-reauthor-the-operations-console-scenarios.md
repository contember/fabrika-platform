---
id: 53
title: Re-author the Operations console browser scenarios
blocked-by: []
---

# 53 — Re-author the Operations console browser scenarios

**Summary.** Three `tests/browser/` scenarios assert an Operations console that stopped
existing in `83581a9` ("restore issue console parity", 2026-07-31). They have been red
since, and the failure looks like an auth regression to anyone running the suite after
an auth change — which is how it was found.

## Problem

Two independent drifts, both confirmed in a live browser rather than inferred:

- **Filters now apply on an explicit `Apply` submit.** The tests only set values. Typing
  into Search changes nothing: no request, no URL change. Affects
  `operations-error-discovery` (**critical** tier) and `operations-bulk-status-and-merge`.
- **The issue detail's headings changed.** `Occurrences` (h2) and `Exception: <title>`
  (h3), where the scenario expects `Latest occurrence` and a bare title. Affects
  `operations-event-release-correlation`.

Nothing is wrong with the application. The scenarios encode an older UI.

## Approach

This is an `opice-reeval`-shaped pass, not a mechanical selector swap: the filter change
altered the interaction model, so the steps have to be re-authored around submit rather
than around typing. Do not weaken an assertion to make it pass — if a scenario can no
longer express its intent, say so and re-plan it.

## Acceptance

`bun run test:browser -- --tier extended` is green, and each re-authored step asserts the
same intent it did before rather than a narrower one.

<!-- Origin: sprint auth-hardening, 2026-08-04; found when WU-D ran the suite against the rebuilt local stack. -->
