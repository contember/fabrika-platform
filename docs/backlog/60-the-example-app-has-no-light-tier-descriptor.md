---
id: 60
title: The example app has no descriptor for the light tier it is deployed on
blocked-by: []
---

# 60 — The example app has no descriptor for the light tier it is deployed on

**Summary.** `notesapi` runs on `fabrika-test` against the shared `db` service, and neither committed
`zerops.yaml` in `examples/zerops-app/` names that service — so the live app cannot be redeployed
from HEAD without editing a file. Effort S.

## Problem

The example ships two build/run descriptors, and each hard-codes a database service name:

| File                          | `NOTES_DATABASE_URL`                                              |
| ----------------------------- | ----------------------------------------------------------------- |
| `zerops.yaml`                 | `${notesdb_connectionString}/${notesdb_dbName}?sslmode=require`   |
| `zerops.shared-postgres.yaml` | `${postgres_connectionString}/${postgres_dbName}?sslmode=require` |

The light tier on `fabrika-test` has neither `notesdb` nor `postgres`: IAM, control, Operations and
the app all share one `postgresql:single@18` named **`db`** (2026-08-03 bring-up, decision 1). The
live service therefore carries `NOTES_DATABASE_URL` as a **service-level variable written through the
env API**, which is why it works.

That variable and a `run.envVariables` entry of the same name cannot coexist: a key a service
declares in its own `zerops.yaml` conflicts on create and never appears in `GET /service-stack/{id}/env`
(verified live, see `docs/reference/zerops-platform.md`). So pushing either committed descriptor at
the live `notesapi` re-declares a key the env API already owns, with no established precedence — which
is why WU-4 left the app on its two-day-old build rather than bringing it to HEAD with the rest of the
installation.

Consequences of leaving it: the deployed `notesapi` still carries the app SDK from before
`38bcc6c` (the SDK's second enforcement path) even though the proxy in front of it is at HEAD, and
`notes` has no return origin registered with IAM, so nobody can sign in to it.

## Approach / acceptance

Decide how an app names a database it does not own. The candidates: a third committed descriptor for
the light tier; making the reference a per-installation service variable the descriptor interpolates;
or dropping the key from `run.envVariables` entirely so the env API is the single owner (which is what
ADR-0004 says about every other per-installation value).

Witness: `zops push notesapi --project fabrika-test` from a clean checkout deploys the example at HEAD
against the shared `db`, and `notes` signs a browser in through the handoff.

## Touch points

`examples/zerops-app/zerops.yaml`, `examples/zerops-app/zerops.shared-postgres.yaml`,
`packages/installation-zerops/zerops/topology.ts`, `docs/reference/zerops-platform.md`.

<!-- Origin: sprint-2026-08-05-zerops-path-correctness.md, WU-4 run log. -->
