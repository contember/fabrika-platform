---
id: 26
title: Retire the standalone Trasa release surface
blocked-by: [./25-migrate-the-ci-workflows.md]
---

# 26 — Retire the standalone Trasa release surface

**Summary.** Publish `@fabrika/app`, deprecate `@trasa/core`, and archive the
standalone repository so new consumers have one supported package.

## Problem

The implementation now lives in `packages/app`, but the released
`@trasa/core@0.0.2` package and its Git repository remain available. Removing
source locally does not redirect existing or new consumers, and retiring the old
package before its replacement is published would leave no installable path.

## Approach / acceptance

- Restore the Fabrika package release pipeline through backlog item 25.
- Publish `@fabrika/app`.
- Mark `@trasa/core` deprecated with a message that names `@fabrika/app`.
- Replace the standalone repository README with the migration path and archive the
  repository.
- Confirm a clean install resolves `@fabrika/app` and the old npm package displays
  the deprecation notice.

## Touch points

Fabrika release workflow, npm package metadata, and the standalone Trasa
repository.

<!-- Origin: ../sprints/sprint-2026-07-29-fabrika-app-runtime.md -->
