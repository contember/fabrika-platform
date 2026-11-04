---
id: 266
title: Fleet-wide framework upgrades
blocked-by: []
---

# 266 — Fleet-wide framework upgrades

**Summary.** For every application below the current framework release, Control opens an upgrade workspace, bumps the
pin, runs the checks in a dev sandbox and opens a pull request. Medium to large.

## Problem

Each platform release ships framework changes. Applications lag behind, and the platform carries every older framework
release in its window ([ADR-0062](../decisions/0062-a-platform-release-serves-older-framework-releases.md)). Raising a pin
is a manual walk through [framework migrations](../reference/framework-migrations.md) per application. Nobody sees which
applications lag until a release leaves the window and Control refuses them.

## Approach / acceptance

For each application whose `@fabrika/app` release (read from the `bun.lock` at its pinned commit) is below the
platform's, Control creates a workspace as it does for MCP authoring, sets every `@fabrika/*` dependency to the
platform's release, binds a dev sandbox and runs `run_checks`. Green: a pull request with the crossed sections of
`framework-migrations.md` and the access diff. Red: the workspace stays open with the failing checks as the brief for an
external agent or a person. Fabrika runs no model ([ADR-0049](../decisions/0049-author-applications-through-mcp-in-control.md)):
anything beyond the version bump and mechanical steps is the agent's.

Why it waits: it reads the framework lag from the [fleet overview](../specs/fleet-overview.md), and its pull requests
should carry the [access-diff check](../specs/access-diff-as-a-github-check.md). An unattended run needs an
[agent task key](../specs/agent-task-keys.md) rather than a person's grants. It waits for those three specs to ship.

The first version is Zerops only. Cloudflare has no authoring target at all: registration refuses `authoring` where the
provider does not declare it (`packages/control/src/api/registry/environments.ts:190`), and Cloudflare's provider does not
(`packages/provider-cloudflare/src/control.ts` sets no `authoring`). Cloudflare needs authoring workspaces first, then dev sandboxes
([271](271-fast-dev-sandboxes-on-cloudflare.md)).

Acceptance: an application one minor behind gets a workspace, a green `run_checks` and a pull request whose
`bun.lock` names the platform's release; an application with a failing check gets an open workspace and no pull request.

## Touch points

- `packages/control/src/mcp/`, `packages/control/src/api/workspaces.ts`, `packages/control/src/github/`
- `packages/control/src/dev/`
- `docs/reference/framework-migrations.md` (a machine-readable form of the mechanical steps, if any)

<!-- Origin: feature ideas review, 2026-11-02. -->
