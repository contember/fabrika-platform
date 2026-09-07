---
id: deptective
kind: tooling
title: deptective — dependency linter for TS monorepos
slot: null
provides: [dependency-linting, monorepo-validation, dev-tooling]
requires: []
recommends: []
conflicts: []
npm: ["deptective@^0.1"]
status: stable
sources:
  - where: "deptective/README.md"
    read: "Rules, config discovery (deptective.config.* or package.json#deptective), and CLI flags (--fix, --dry-run)."
  - where: "deptective/src/cli.ts"
    read: "CLI surface + the programmatic API (lint/loadConfig/applyFixes)."
---

# deptective

## What it is

A CLI + programmatic **dependency linter** for TypeScript monorepos: finds missing,
unused, and misclassified dependencies (and out-of-sync project references) by static
import analysis, and auto-fixes the fixable ones. A CI gate for package coherence —
additive dev tooling, not part of the runtime stack (`slot: null`).

## When & why to use

- Keep a monorepo's `package.json`s honest (every import declared, no dead deps, dev-deps only in test files).
- Enforce policies (banned packages, type-only deps in the right field) before build.

## When NOT to use

- A single flat package with no deps; non-TS ecosystems.

## Gotchas

- Whitelist **virtual modules** (`globalModules: ['virtual:*']`) or get false positives (relevant: buzola/lopata virtual modules).
- `testPatterns` decide where `devDependencies` are allowed; misconfigure and CI blocks.
- `--fix` rewrites `package.json` in place; `--dry-run` previews.

## Relationships — why

- **slot `null`** — additive dev tooling; composes with any stack (especially Bun monorepos).
