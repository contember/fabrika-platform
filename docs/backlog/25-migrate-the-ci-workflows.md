---
id: 25
title: Migrate the CI workflows
blocked-by: []
---

# 25 — Migrate the CI workflows

`.github/workflows/` was not migrated from either ancestor repo. Nothing in this
repository builds, tests, publishes or deploys automatically.

## What existed

- **propustka**: a `Deploy` workflow (stage/prod through GitHub Environments, the
  only place the deploy vars and secrets live) and a `release.yml` publishing
  `@propustka/core` + `@propustka/client` on a `v*` tag via **OIDC trusted
  publishing — no npm token**. Keep that property.
- **vozka**: `runner-image.yml`, which builds and pushes the runner container and
  bumps the pinned tag in `packages/runner-cloudflare/image.json`. That file still names the
  workflow as the thing that maintains it, and its trigger paths point at
  the pre-merge runner/core/config package layout.

## Also decide

CI currently has no Postgres or S3, so ~107 tests skip. A green run that skipped the
entire Postgres half is misleading; the workflow should provide both services
(containers are cheap) or the run should report loudly what it did not exercise.

## Acceptance

Push and tag pipelines exist, publish under the `@fabrika/*` names via trusted
publishing, and the test job exercises the Postgres and S3 suites rather than
skipping them.
