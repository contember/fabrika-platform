---
id: 184
title: A fix for new installations misses existing ones
blocked-by: []
---

# 184 — A fix for new installations misses existing ones

**Summary.** Three v0.4.x fixes worked for a fresh install and failed on an existing installation after
`platform upgrade`. Every change to generated installation files, environment variables or provider state must say
how an existing installation converges. Docs only.

## Problem

A fresh install and an upgrade take different code paths. Fixes that changed only the install path missed the
upgrade path:

- a sensitive environment variable, which Zerops does not read back, stayed on existing services;
- the sidecar workflow, generated once at `init`, kept a floating Bun version that `upgrade` did not rewrite;
- a bucket created by an older version kept a provenance that the new check did not accept.

A real installation found each one after the release.

## Decision

A change that alters generated installation files, environment variables or provider state states how an existing
installation converges on `fabrika platform upgrade`. If no upgrade step converges it, the change adds that step or
documents the operator step. The checklist lives in the root `CLAUDE.md` (for code changes) and in `docs/CLAUDE.md`
(for ADRs, whose Consequences name the rollout path).

## Scope

- In: the checklist in the root `CLAUDE.md`, one rule in the ADR section of `docs/CLAUDE.md`, one line in the ADR
  template.
- Out: an automated upgrade test (a fixture of an older sidecar, upgraded to `HEAD`); file it when such a fixture
  exists.

## Acceptance criteria

- The root `CLAUDE.md` lists the four questions: generated files, environment variables, provider state, floating
  pins.
- `docs/CLAUDE.md` and `docs/decisions/_template.md` ask an ADR for the rollout path of an existing installation.

## Touch points

`CLAUDE.md`, `docs/CLAUDE.md`, `docs/decisions/_template.md`.
