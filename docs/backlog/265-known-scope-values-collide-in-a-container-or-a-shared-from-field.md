---
id: 265
title: The leak sweep reports a false leak when both known scope values lie in one container
blocked-by: []
---

# 265 — The leak sweep reports a false leak when both known scope values lie in one container

**Summary.** Over known scope values (an enum `from` field), the leak sweep can fail a correct handler: both worlds
share the container a migration stored them in, and that container's value counts as the other scope's. Effort: S.

## Problem

The opt-in leak sweep (`leakSweep` → `kit.swept` → `leakCase`, `packages/app/src/testing/endpoint-access.ts`) uses
the stored rows of known scope values as they are (`knownValues`, `seedWorld`, `packages/db/src/testing-shared.ts`).
When the table that owns the dimension lies in a container (a country in a continent) and a migration wrote both known
values in the same container, the two worlds share the grant scope. The only guard compares the known dimension's
values, not their containers.

`worldValues(other)` then holds the shared container value, and `shownValue` quotes only the known values, so the
container's value is matched as a raw substring. An `on` endpoint over countries whose answer holds `"continent":"eu"`
(or any text containing `eu`) fails with "the answer to one scope holds eu, a value of another scope". A stored row
takes no seed or pin, and the kit overwrites the `from` field the author gives in `inputs`, so the author has no way
around it.

The sweep asks no endpoint with several capabilities (`isSwept` requires one action), so the shared `from` field of
two capabilities no longer applies.

## Approach / acceptance

- Pick two known values whose chains differ in every container, or, when none exist, skip the case with a hint that
  names the shared container. Quote stored chain values the way stored texts are quoted.
- Witness: an enum over countries a migration wrote in one continent; the sweep reports no leak for a handler that
  answers the country with its continent.

## Touch points

`packages/db/src/testing-shared.ts`, `packages/app/src/testing/endpoint-access.ts`.

<!-- Origin: review round 2 of the known-scope-values change (#105); rescoped to the leak sweep after the generated
tests were removed. -->
