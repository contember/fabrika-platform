---
id: 59
title: Bring `fabrika-test` to HEAD — it still calls itself `local`
blocked-by: []
---

# 59 — Bring `fabrika-test` to HEAD — it still calls itself `local`

**Summary.** `control` and `operations` on `fabrika-test` carry `ENVIRONMENT=local` and `iam` still
carries `LOCAL_DEV_LOGIN`. The command that fixes this shipped and has been proven live — on a
different installation. Effort S, and it is now one command plus a check rather than a decision.

## What changed since this was filed

`fabrika platform deploy --provider=zerops` exists, writes the environment name on every service, and
ran unattended from an operator's CI
([archive](../archive/sprint-2026-08-06-zerops-platform-deploy.md)). So the "nothing writes these
variables as part of a deploy" cause is fixed in code. What remains is that **`fabrika-test` has never
been deployed by it** — every live acceptance was performed on `fabrika-install-test` instead.

## Problem

Re-read live 2026-08-11, keys and non-secret values only:

| Service      | `ENVIRONMENT` | other                   |
| ------------ | ------------- | ----------------------- |
| `iam`        | `stage`       | `LOCAL_DEV_LOGIN=false` |
| `control`    | **`local`**   | —                       |
| `operations` | **`local`**   | —                       |

Unchanged since 2026-08-05. `local` is precisely the value that turns bypasses on — IAM's
`localDevLogin`, its ephemeral signing key and its credential-less caller path are all gated on exactly
this string — so a live installation claims to be a developer's laptop, and the startup banner tells an
operator the same wrong thing.

IAM's principal table also still shows a `local_dev` session and an `externalId: local-dev-admin`
principal from the bring-up: evidence the bypass was live at some point on a public host.

**The fail-closed refusal shipped, and is inert here.** `readEnvironmentName`
(`packages/auth-core/src/environment.ts:64-78`) throws when a composition declares `ENVIRONMENT=local`
**and** states a non-loopback public origin. Neither `control` nor `operations` on `fabrika-test`
declares its own public origin, so the function returns `local` unchallenged and nothing refuses to
boot. That is not reassurance — it is the contradiction going unnoticed for a second reason. The
refusal arms the moment an origin is written without the environment name being corrected in the same
run, and `platform deploy` writes both together, which is why running it is the fix rather than the
risk.

## Approach / acceptance

Run `fabrika platform deploy --provider=zerops` against `fabrika-test` — `--dry-run` first, since the
manifest merge's failure mode is taking the deployed `notes` application offline — and delete
`LOCAL_DEV_LOGIN` from the live IAM afterwards. Decide what a single-project light-tier installation
should call itself; `stage` is what IAM already says and there is no reason to invent a second answer.

Witness: every service on `fabrika-test` reads back the same non-`local` environment name, no
`LOCAL_DEV_LOGIN` key exists on the installation, and the deployed `notes` application is still served
after the run.

## Touch points

The live `fabrika-test` service variables. No code — this is an operation, and the code that performs
it is already written and proven.

<!-- Origin: sprint-2026-08-05-zerops-path-correctness.md, WU-4 run log; residue folded in from
     sprint-2026-08-06-zerops-platform-deploy at close. -->
