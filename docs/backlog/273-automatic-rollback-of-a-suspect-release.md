---
id: 273
title: Automatic rollback of a suspect release
blocked-by: []
---

# 273 — Automatic rollback of a suspect release

**Summary.** An environment opts in, and Control rolls a release back by itself when the watch window's observed
verdict closes `suspect` and the rollback verdict is `safe`. It makes Control deploy without a person, so it comes with
its own ADR. M.

## Problem

The [release watch window](../specs/release-watch-window-and-rollback.md) warns about a suspect release and offers a
manual rollback with its verdict. Nobody acts on it at night: the alert waits for a person, and on a fleet of small
applications nobody is on call. The review of that spec moved the automatic half out of it, to be decided separately.

## Approach / acceptance

Built on the watch window and `runs.rollback`, both from that spec:

- An environment flag `auto_rollback`, off by default (a column on `app_envs`, or a row table like
  `app_env_backup_schedules`). Setting it takes the same human rule as `apps.environments.protect`: a `user` principal
  with no OAuth or link claims and no bearer, so a builder key or an MCP token cannot switch it on.
- Control's maintenance pass asks Operations for windows whose **observed** verdict closed `suspect` since its cursor,
  through a private `POST /private/releases/suspects` under the release sync key, beside `/private/releases/reconcile`;
  Control reads its 404 (an older Operations) as "none". A reported-only suspect never qualifies: the ingest key is
  public, so ingested errors can be forged, and a rollback driven by them would let anyone undo a release, a security
  fix included.
- For each one on an environment with the flag, Control computes the rollback verdict again with a fresh ledger and
  starts `runs.rollback` only when it is `safe` and the suspect run is still the latest succeeded run.
  `migrations_unknown` never qualifies, so this is Cloudflare-only until Control can read the Zerops ledger.
- Guards: never roll back a run that itself has `rollback_of`; at most one automatic rollback per environment until a
  person deploys again; never start a rollback that would park, because only a person approves (ADR-0050).
- Audit: maintenance holds no token, and IAM files an audit event under the caller's verified token
  (`packages/auth/src/client.ts:44-50`). The record is the run row: actor `control:auto-rollback`, `rollback_of`, and
  the verdict line in the run log.
- A new ADR: "a suspect release rolls back only on observed evidence, when nothing migrated or widened since the
  target", with a one-line pointer from ADR-0050 §6.

Acceptance (Control maintenance with a fake Operations): opted in and safe → one run; a second pass → no second run;
`widens` or `migrated` → no run; a newer deploy meanwhile → no run; `suspects` answering 404 → no error; forged browser
errors with healthy checks → no run; setting the flag with an MCP token → refused.

## Touch points

- `packages/control/src/cron.ts` (maintenance), `packages/control/src/api/runs.ts`, `packages/control/src/approval/human.ts`
- `packages/operations/src/` (the `suspects` endpoint), `packages/operations-contract/src/release-schemas.ts`
- Control migrations (both dialects), `docs/decisions/`

<!-- Origin: review of the release watch window spec, 2026-11-04. -->
