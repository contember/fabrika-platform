---
id: 182
title: Parallel agents share one checkout
blocked-by: []
---

# 182 — Parallel agents share one checkout

**Summary.** Agents that work in parallel in one checkout break each other's typecheck, test runs and commits. Make
one git worktree per agent the documented default. Docs only.

## Problem

During the v0.4.3–v0.4.5 hotfixes several agents worked in the same checkout. One agent's uncommitted change made
another agent's typecheck and tests fail, and a branch switch for the hotfix moved files under agents that were still
editing. Nothing in the repository tells an agent to isolate itself.

## Decision

Each agent that works in parallel with another works in its own git worktree, on its own branch. The lead integrates
the branches. The rule lives in the root `CLAUDE.md`, which every agent reads.

## Scope

- In: a short section in the root `CLAUDE.md`: one worktree per agent, `bun install` per worktree, never switch the
  branch of a checkout that another agent uses, one local Docker stack per machine (it has a fixed project name).
- Out: tooling that creates worktrees; a local stack per worktree.

## Acceptance criteria

- The root `CLAUDE.md` states the rule and its practical consequences (install per worktree, one local stack).

## Touch points

`CLAUDE.md`.
