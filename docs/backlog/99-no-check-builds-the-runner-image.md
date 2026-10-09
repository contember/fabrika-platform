---
id: 99
title: No check builds the runner image
blocked-by: []
---

# 99 — No check builds the runner image

**Summary.** The Cloudflare deploy runner's Docker image is built for the first time when an installation deploys
the runner; no CI job and no test builds or smoke-tests it. Small effort.

## Problem

`packages/runner-container/Dockerfile` copies a slim workspace of 17 packages and runs `bun install` (line 65).
`packages/runner-cloudflare/fabrika-runner.config.ts:65` points the container image at that Dockerfile, so wrangler
builds it during `fabrika platform deploy --provider=cloudflare`. The package has `docker:build` and `docker:smoke`
scripts (`packages/runner-container/package.json`), but nothing runs them: `.github/workflows/ci.yml` (jobs
`quality`, `test`, `build`, `release-artifacts`) and `release.yml` start no Docker build. The only guard is
`docker-workspace.test.ts`, which checks statically that each `workspace:*` dependency is listed and copied.

It does not catch an npm dependency that fails to install or resolve in the slim workspace, a package that imports a
file the image does not copy, or a runtime import that fails at start. The image's `bun install` also runs without a
lockfile, so its npm dependencies (`oblaka-iac ^0.0.18` and every transitive one) resolve to whatever is newest at
build time. Recent changes copied `@fabrika/db` and `@fabrika/platform-node` into the image (`39b4f374`, `3c1e16b4`);
neither was built.

## Approach / acceptance

- A CI job that builds the image (`docker:build`) and runs `docker:smoke` (the executor's `--help` and a dry-run
  deploy of `docker/smoke/fabrika.config.ts`), on every change under the packages the image copies.
- The image installs from a lockfile, so the build that CI checks is the build that deploys.
- Witness: a dependency added to a copied package without a matching `COPY` fails the job; a green job proves the
  executor starts and plans a deploy.

## Touch points

`.github/workflows/ci.yml`, `packages/runner-container/Dockerfile`, `packages/runner-container/docker/package.json`,
`packages/runner-container/package.json`, `packages/runner-container/CLAUDE.md`.

<!-- Origin: a finding of the application framework run (docs/ideas/app-framework-implementation-plan.md). -->
