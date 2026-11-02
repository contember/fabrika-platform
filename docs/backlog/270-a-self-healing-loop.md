---
id: 270
title: A self-healing loop
blocked-by: [../specs/operations-tools-in-the-authoring-mcp.md, ../specs/release-watch-window-and-rollback.md, ../specs/agent-task-keys.md]
---

# 270 — A self-healing loop

**Summary.** An Operations alert hands a new issue or a suspect release to an external agent with a task key; the agent
reads the issue, fixes it in a workspace and opens a pull request that a person merges. A bold bet; large.

## Problem

A fleet of small applications has nobody on call. Most incidents are a regression from the last change. Today a person
reads the alert, copies the stack trace into an agent session and drives the fix by hand.

## Approach / acceptance

An alert channel of a new kind, `agent`, beside the webhook channels (`packages/operations/src/alerts.ts`). On a new
issue or a `suspect` release from the [watch window](../specs/release-watch-window-and-rollback.md) it calls an external
agent runner (for example a roj preset) with an [agent task key](../specs/agent-task-keys.md) scoped to that
application. The agent reads the issue through the [Operations MCP tools](../specs/operations-tools-in-the-authoring-mcp.md),
creates a workspace, reproduces in a dev sandbox (with [masked data](269-masked-production-data-for-dev-and-stage.md)
when it exists), runs the checks, deploys stage and opens a pull request. A person merges. Resolving the issue in the
next release closes the loop.

Fabrika runs no model ([ADR-0049](../decisions/0049-author-applications-through-mcp-in-control.md)): the runner is an
ordinary principal outside the platform, and every step it takes is authorized and audited as that task key.

Open: a budget per application per week, an issue the agent reopens in a loop, and who is accountable for the pull
request. Decide them in the task key's budgets before building the channel.

Acceptance: a new issue on a stage environment with an `agent` channel produces exactly one task key and one runner
call; the resulting pull request and every write carry the task key's agent-for-person mark; a second alert for the same
issue while the task is open makes no second call.

## Touch points

- `packages/operations/src/alerts.ts`, `packages/operations/src/webhook-target.ts`
- `packages/iam/` (task key issuance), `packages/control/src/mcp/`

<!-- Origin: feature ideas review, 2026-11-02. -->
