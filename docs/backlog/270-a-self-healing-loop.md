---
id: 270
title: A self-healing loop
blocked-by: []
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

It waits for the [Operations MCP tools](../specs/operations-tools-in-the-authoring-mcp.md), the
[watch window](../specs/release-watch-window-and-rollback.md) and [agent task keys](../specs/agent-task-keys.md) to ship.

**Consent is the first design question.** A task key is issued only by a signed-in person, and an OAuth grant lives only
while the consenting session does (`packages/iam/src/oauth.ts:235`). An alert has no person. Two shapes: a standing
template a person approves in advance (application, scopes, ceiling, expiry, budget), from which IAM issues one task per
alert and names that person as accountable; or a person issues each task from the alert in the console, and the loop
starts there. Default: the human step first; a standing template only after its ceiling, expiry and revocation are
designed as an ADR.

Open: a budget per application per week, an issue the agent reopens in a loop, and who is accountable for the pull
request. Decide them in the task key's budgets before building the channel.

Acceptance: a new issue on a stage environment with an `agent` channel produces exactly one task key, issued under
a person's consent and naming that person, and one runner call; the resulting pull request and every write carry the task key's agent-for-person mark; a second alert for the same
issue while the task is open makes no second call.

## Touch points

- `packages/operations/src/alerts.ts`, `packages/operations/src/webhook-target.ts`
- `packages/iam/` (task key issuance), `packages/control/src/mcp/`

<!-- Origin: feature ideas review, 2026-11-02. -->
