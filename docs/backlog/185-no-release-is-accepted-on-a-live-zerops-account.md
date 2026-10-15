---
id: 185
title: No release is accepted on a live Zerops account
blocked-by: []
---

# 185 — No release is accepted on a live Zerops account

**Summary.** A real installation found every v0.4.x defect; CI found none. Run a fresh-install acceptance on a
dedicated Zerops account for every release, from CI. Large effort; release-relevant.

## Problem

CI runs against the local Zerops emulator, which is a test double for the API and not evidence about the platform
(`packages/local-stack/CLAUDE.md`). The live `platform-facts` suite (`bun run test:live`) checks single platform
facts, not an installation. A release is published without a run on a real account, so defects in install, deploy
and proxy wiring reach operators first.

## Decision

A workflow runs a full acceptance on a dedicated Zerops account, with a dedicated token secret:

1. `fabrika platform install` of the candidate ref into a fresh project;
2. create a namespace;
3. deploy an application with its own database (the Zerops example);
4. send one authenticated request through the proxy that reads from that database;
5. tear down every project the run created, also when a step fails.

It runs on `workflow_dispatch` with a ref, and for a release tag before the publish job. A failure blocks the
publish.

## Scope

- In: a GitHub Environment that holds the Zerops token (`FABRIKA_ACCEPTANCE_ZEROPS_TOKEN`) and the GitHub App
  credentials the install needs; an acceptance script under `scripts/` that drives only the public CLI; teardown by a
  run-unique project name prefix, so the next run removes what a crashed run left.
- Out: a Cloudflare acceptance; the production two-project shape
  ([05](05-bring-up-on-a-real-zerops-account.md)); the facts in
  [116](116-verify-the-paved-road-zerops-facts-on-a-real-account.md).

## Acceptance criteria

- One `workflow_dispatch` run on a known-good ref passes end to end and leaves no project behind.
- A deliberately broken ref fails at the named step and still tears down.
- The publish job of `release.yml` depends on the acceptance job; `docs/reference/release-process.md` describes it,
  with its cost and duration.

## Touch points

`.github/workflows/`, `scripts/`, `docs/reference/release-process.md`, `docs/reference/installing-on-zerops.md`.
