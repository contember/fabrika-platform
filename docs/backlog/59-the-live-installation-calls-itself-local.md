---
id: 59
title: Two live services are configured ENVIRONMENT=local
blocked-by: []
---

# 59 — Two live services are configured `ENVIRONMENT=local`

**Summary.** `control` and `operations` on `fabrika-test` carry `ENVIRONMENT=local`; IAM on the same
installation carries `stage`. Harmless today, load-bearing the moment anything branches on it. Effort S.

The drift exists because nothing writes these variables as part of a deploy;
[ADR-0025](../decisions/0025-the-operator-installs-the-platform-fabrika-deploys-apps.md) makes that a
step of `fabrika platform deploy` ([61](./61-make-platform-deploy-an-unattended-command.md)). Fixing
the live values without that step just resets the clock.

## Problem

Read live on 2026-08-05 (`zops env show --service <svc> --json`, compared without printing values):

| Service      | `ENVIRONMENT` |
| ------------ | ------------- |
| `iam`        | `stage`       |
| `control`    | **`local`**   |
| `operations` | **`local`**   |

At HEAD the value reaches only a log line in each of those two Bun processes
(`packages/control/src/node/server.ts`, and `Env.ENVIRONMENT` in Operations); every behavioural
`=== 'local'` branch is either in IAM's runtime or in a Cloudflare `fabrika.config.ts`, which a Zerops
process never evaluates. So nothing is bypassed right now.

What makes it worth fixing rather than ignoring: `local` is precisely the value that turns bypasses
on. IAM's `localDevLogin`, its ephemeral signing key and its credential-less caller path are all
gated on exactly this string, and the next component that adds such a branch inherits a live
installation that already claims to be a developer's laptop. The startup banner also states it, so an
operator reading logs is told the wrong thing.

Related, on the same installation: `iam` carries a `LOCAL_DEV_LOGIN` variable (set to a value other
than `true`, so inert, and inert twice over because `ENVIRONMENT` is `stage`). IAM's principal table
still shows a `local_dev` session and an `externalId: local-dev-admin` principal from the bring-up,
which is the evidence the bypass was live at some point on a public host.

## Approach / acceptance

Decide what a single-project light-tier installation should call itself (`stage` is what IAM says)
and write that value on every service; delete `LOCAL_DEV_LOGIN` from the live IAM rather than leaving
an inert switch on a publicly-reachable identity service. Then decide whether a service should refuse
to boot with `ENVIRONMENT=local` when it can see it is not local — the fail-closed direction the rest
of the runtime already prefers — or whether the value stays a label.

Witness: every service on `fabrika-test` reads back the same non-`local` environment name, and no
`LOCAL_DEV_LOGIN` key exists on the installation.

## Touch points

The live `fabrika-test` service variables; `packages/iam/src/services.ts` and
`packages/*/src/node/runtime.ts` if the refusal is adopted; ADR-0004's bring-up variable list.

<!-- Origin: sprint-2026-08-05-zerops-path-correctness.md, WU-4 run log. -->
