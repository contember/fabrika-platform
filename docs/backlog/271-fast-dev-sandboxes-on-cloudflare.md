---
id: 271
title: Fast dev sandboxes on Cloudflare
blocked-by: []
---

# 271 — Fast dev sandboxes on Cloudflare

**Summary.** A Cloudflare dev environment runs one application object per workspace, so an agent on Cloudflare gets the
seconds-per-commit loop that dev sandboxes give on Zerops. Large.

## Problem

The dev environment is Zerops only ([ADR-0049](../decisions/0049-author-applications-through-mcp-in-control.md) rule 9:
dev sandboxes on a Zerops Box host). On Cloudflare an agent waits for a full stage deploy each iteration, and
`bind_dev`, `run_checks` and `reset_dev` have no target.

## Approach / acceptance

On Cloudflare an application environment already runs in one Durable Object over its own SQLite
([ADR-0065](../decisions/0065-an-application-on-cloudflare-runs-in-one-durable-object-per-environment.md)). A dev
environment keys that object by workspace instead of environment, so isolation is a key change, not a new database. The
proxy Worker serves it at `<workspace>.<domain>`. A commit replaces the changed code without a full deploy (a dynamic
Worker loader, or a per-workspace script upload); Control already tracks workspace heads and sandbox state
(`packages/control/src/dev/`).

Verify first: how fast Cloudflare can swap one workspace's code without a deploy, the loader's availability and the
script limits per account. Postgres applications on Cloudflare would need a schema per workspace. Decide between this
and [272](272-authoring-workspaces-on-kompjutr.md) after measuring where hosted agents lose time.

Acceptance: on a Cloudflare installation, `bind_dev` creates a workspace object, a commit is served within seconds, and
`run_checks` and `reset_dev` behave as on Zerops.

## Touch points

- `packages/provider-cloudflare/`, `packages/control/src/dev/`
- the Cloudflare proxy Worker

<!-- Origin: feature ideas review, 2026-11-02. -->
