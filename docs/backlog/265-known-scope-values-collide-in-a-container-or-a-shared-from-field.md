---
id: 265
title: Known scope values can collide in one container or in a field two capabilities share
blocked-by: []
---

# 265 — Known scope values can collide in one container or in a field two capabilities share

**Summary.** Two shapes where the generated cases over known scope values (an enum `from` field, #105) give both
callers the same grant, so a correct handler fails its denied case. Neither shape worked before #105 either; the enum
field was refused with 400. Effort: S.

## Problem

- **Both stored values in one container.** When the table that owns the dimension lies in a container (a country in
  a continent), the grant is on the container (`grantDimension`). If a migration wrote both known values in the same
  container, the two worlds share the grant scope (`knownValues` / `storedChain`, `packages/db/src/testing-shared.ts`).
  The denied case is then answered 200 where the generated test asserts 404. The leak case reports the shared
  container value as a leak, matched as a raw substring, because `shownValue` quotes only known scope values. A stored
  row takes no seed or pin, so the author has no way around it.
- **Two capabilities on one enum `from` field.** In the capability case (`packages/app/src/testing/endpoint-access.ts`),
  the named capability addresses the field with the other scope's value. Then each other `on`/`in` capability
  addresses the same field with its own scope. Over the same enum that is the named one's own value, now stored, so the
  request asks a scope where the caller holds both actions. The answer is 200 where the test asserts 404 or 403. A
  plain string field is not affected.

## Approach / acceptance

- Refuse with a clear message when the two worlds' grant scopes or chain values coincide, or pick known values that
  lie in different containers. Quote stored chain values the way stored texts are quoted.
- When another capability shares the named one's `from` field, address it with the named one's other target and grant
  the other capability's action there.
- Witness: an enum over countries a migration wrote in one continent, and an endpoint with two capabilities on one
  enum field. Each answers its denied case with 404 or 403.

## Touch points

`packages/db/src/testing-shared.ts`, `packages/app/src/testing/endpoint-access.ts`.

<!-- Origin: review round 3 of the known-scope-values change (#105). -->
