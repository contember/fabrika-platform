---
id: 25
title: Bootstrap the @fabrika npm packages and activate trusted publishing
blocked-by: []
---

# 25 — Bootstrap the `@fabrika` npm packages and activate trusted publishing

**Summary.** The repository automation is locally verified, but it has not run on GitHub and npm trusted publishing cannot create a package name for the first time. Prove the hosted CI workflow, bootstrap the twenty public packages through an authorized CI run, then bind and verify future releases through Fabrika's OIDC workflow.

## Current boundary

All twenty public manifests name packages that do not yet exist in the npm registry. The release workflow deliberately checks this before its first mutation and stops with the complete missing-package list. The committed workflows also need a hosted GitHub Actions witness after they are pushed; local execution is not that witness.

The local release graph currently stops earlier because public `@fabrika/provider-cloudflare` depends on private `@fabrika/proxy`. This pre-existing package-boundary regression must be resolved before the bootstrap workflow can produce the complete artifact set.

npm requires a package to exist before its trusted-publisher relationship can be configured. Publishing from a laptop is forbidden. The bootstrap therefore needs a short-lived, explicitly approved CI credential; routine releases must remain tokenless.

## Approach / acceptance

1. Restore a valid public package graph and obtain a clean local `release:validate`, `release:pack`, and `release:smoke` run for all twenty packages.
2. Push the committed automation and obtain a clean hosted run of every `.github/workflows/ci.yml` job, including PostgreSQL, MinIO, deployable builds, and release artifacts.
3. Add a temporary, protected GitHub Actions bootstrap path that consumes the exact tarballs produced by `bun run release:pack` and `bun run release:smoke`.
4. Publish the initial common version with provenance using a short-lived granular npm token stored only in a protected GitHub Environment. Do not expose the token to pull requests or reusable workflows.
5. Configure every package's trusted publisher for organization `contember`, repository `fabrika-platform`, workflow `release.yml`, and the `npm publish` action.
6. Remove the bootstrap workflow and token after all twenty relationships exist. Restrict traditional token publishing for the packages.
7. Push the next `v<semver>` tag and prove that `.github/workflows/release.yml` publishes the complete co-versioned set through OIDC. Re-run the same workflow and prove its integrity comparison makes the retry a verified no-op.

Acceptance: hosted CI is green without skipped backend suites; all twenty package pages exist, show provenance for the CI-produced release, and trust only `release.yml` for routine publishing. A clean external project installs `@fabrika/cli`, `@fabrika/app`, and both provider packages from npm, and a same-tag retry is a verified no-op.

## Touch points

- npm organization and package settings
- a temporary protected GitHub bootstrap workflow
- `.github/workflows/release.yml`
- [`../reference/release-process.md`](../reference/release-process.md)

<!-- Rescoped from the pre-merge CI migration item by the Automated release readiness sprint. -->
