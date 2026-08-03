---
id: 41
title: Write service variables without a pre-read
blocked-by: []
---

# 41 — Write service variables without a pre-read

**Summary.** `putServiceEnv` lists a service's variables before writing one, and that
list call **never succeeds**. The bring-up order
[ADR-0004](../decisions/0004-secrets-live-in-the-platform.md) chose cannot complete
as written — not on a fresh service, and not on an established one either.

> **Verified live on 2026-08-03** (sprint
> [`zerops-live-bringup`](../archive/sprint-2026-08-03-zerops-live-bringup.md)), and
> the answer is worse than this item assumed. Three results settle the design:
>
> | Call                                                              | Result                                                                                                                    |
> | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
> | `GET /service-stack/{id}/user-data`                               | `400 serviceStackNotFound` — **always**, on services deployed successfully and repeatedly, not only before a first deploy |
> | `POST /service-stack/{id}/user-data`                              | works from the moment the service exists                                                                                  |
> | `POST /service-stack/{id}/user-data` on an existing key           | `400 userDataDuplicateKey`, "UserData key 'X' is not unique in service stack frame of reference" — it does NOT replace    |
> | `POST /user-data/search` with `clientId` **and** `serviceStackId` | works — this is the only read path                                                                                        |
> | `PUT /user-data/{id}`                                             | requires `key` as well as `content`                                                                                       |
>
> This also answers question #2 of [`05`](./05-bring-up-on-a-real-zerops-account.md)
> by exercise: POST conflicts, it does not replace.
>
> The consequence for the fix below: "fall back to list + `PUT` on conflict" cannot
> use the list endpoint at all. The conflict path must use `POST /user-data/search`,
> which needs a `clientId` — a value `ZeropsApiOptions` does not currently carry, so
> this is a signature change rather than a reordering of two calls.
>
> The bring-up in that sprint worked around it with a standalone script; nothing in
> `packages/` is fixed yet.

## Problem

`packages/provider-zerops/src/api.ts:703-716` implements create-or-update as
`GET /service-stack/{id}/user-data` → `POST` if the key is absent, `PUT /user-data/{id}`
if present. The comment says why: it is correct whether POST replaces or conflicts.

The endpoint answers **`400 serviceStackNotFound` unconditionally** — the error names
the wrong cause, and the "before the first deploy" qualifier in earlier notes was too
generous (see the verified table above).

That breaks the ADR-0004 bring-up path verbatim: provision every service
`startWithoutCode: true` → write its secrets through the env API → deploy. Every
secret in step 2 is written to a service with no deploy, so every write begins with a
list call that returns 400. The same applies to `syncZeropsProxy`
(`packages/control/src/node/zerops-proxy.ts:78-84`), which writes
`FABRIKA_PROXY_MANIFEST_JSON` to a freshly provisioned proxy before triggering its
first build.

The failure is also hard to diagnose from what we log: `apiError`
(`api.ts:546-550`) folds the status into a message string, so nothing downstream can
branch on `400` versus a genuinely missing service.

## Approach / acceptance

- Write first, read only on conflict: `POST /service-stack/{id}/user-data`, and on
  `userDataDuplicateKey` resolve the record through `POST /user-data/search` and
  `PUT /user-data/{id}` (sending `key` as well as `content`). The list endpoint is
  not an option — see the verified table above.
- Thread the `clientId` into the API client, since the search call requires it.
- Give the API client a typed error carrying the HTTP status and the platform error
  code, so a caller can distinguish "not readable yet" from "no such service"
  without parsing a message. Keep the existing redaction: this path carries secret
  values.
- Do not paper over the 400 by treating a failed list as an empty list — that would
  silently write into a service id that does not exist.
- Acceptance: an emulator test drives the full ADR-0004 order — provision without
  code, write every secret, deploy — against a service whose `user-data` list always
  answers 400, and the run completes. The live statuses and error codes are already
  recorded in [`../reference/zerops-platform.md`](../reference/zerops-platform.md).

## Touch points

- `packages/provider-zerops/src/api.ts`
- `packages/control/src/node/zerops-proxy.ts`
- Zerops emulator fixtures

<!-- Origin: Zerops skill conformance review, 2026-07-31. -->
