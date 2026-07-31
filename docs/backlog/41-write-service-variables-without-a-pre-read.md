---
id: 41
title: Write service variables without a pre-read
blocked-by: []
---

# 41 — Write service variables without a pre-read

**Summary.** `putServiceEnv` lists a service's variables before writing one. That
list call is documented to fail with `400 serviceStackNotFound` before the
service's first deploy — which is exactly when fabrika writes its first secret. The
bring-up order [ADR-0004](../decisions/0004-secrets-live-in-the-platform.md)
chose cannot complete as written.

## Problem

`packages/provider-zerops/src/api.ts:703-716` implements create-or-update as
`GET /service-stack/{id}/user-data` → `POST` if the key is absent, `PUT /user-data/{id}`
if present. The comment says why: it is correct whether POST replaces or conflicts.

A live-verified upstream note records that the same endpoint answers
**`400 serviceStackNotFound` before the first deploy**, even though the service
plainly exists and the import just wrote secrets into it — the error names the wrong
cause. The stack is found; its variables are simply not readable yet.

That is the ADR-0004 bring-up path verbatim: provision every service
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

- Write first, read only on conflict: `POST /service-stack/{id}/user-data`, and fall
  back to list + `PUT` only when the response says the key already exists. This
  removes the pre-read from the path that runs before any deploy and answers backlog
  [`05`](./05-bring-up-on-a-real-zerops-account.md)'s question #2 by exercising it
  rather than by asking.
- Give the API client a typed error carrying the HTTP status and the platform error
  code, so a caller can distinguish "not readable yet" from "no such service"
  without parsing a message. Keep the existing redaction: this path carries secret
  values.
- Do not paper over the 400 by treating a failed list as an empty list — that would
  silently write into a service id that does not exist.
- Acceptance: an emulator test drives the full ADR-0004 order — provision without
  code, write every secret, deploy — against a service that answers 400 on
  `user-data` until its first deploy, and the run completes. Confirm the real status
  and error code on a live account and record them in
  [`../reference/zerops-platform.md`](../reference/zerops-platform.md).

## Touch points

- `packages/provider-zerops/src/api.ts`
- `packages/control/src/node/zerops-proxy.ts`
- Zerops emulator fixtures

<!-- Origin: Zerops skill conformance review, 2026-07-31. -->
