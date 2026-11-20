---
id: 291
title: An existing Cloudflare installation keeps its legacy resource names
blocked-by: []
---

# 291 — An existing Cloudflare installation keeps its legacy resource names

**Summary.** A Cloudflare installation created before `FABRIKA_CLOUDFLARE_NAMES` keeps `vozka*`, `propustka*` and
`operations*` resources forever; nothing moves it onto the `fabrika-*` names. P3, size M.

## Problem

`platform init` records `FABRIKA_CLOUDFLARE_NAMES=fabrika` for a new installation only
([ADR-0024](../decisions/0024-canonical-environment-names.md)). An existing one has no such variable and deploys under
the legacy names on every upgrade, because renaming a resource in place would leave its data behind: oblaka adopts
resources by name, so the new name would be a new, empty D1 database, bucket, queue and state namespace. The account's
dashboards and every operator-facing name therefore differ between older and newer installations.

## Approach / acceptance

An operator-run migration, per installation, with the installation frozen for its length: copy each D1 database
(`wrangler d1 export` / `import`) and each bucket into the new names, drain the deploy and ingest queues, move the oblaka
state, set the variable, deploy, verify, then delete the legacy resources. Applications' bindings to IAM follow on their
next deploy, since Control names IAM's Worker in every job. Acceptance: a legacy installation in a throwaway account
migrates with its data, applications and sessions intact, and a deploy after it creates no legacy resource.

## Touch points

`packages/provider-cloudflare/src/platform-names.ts`, `packages/provider-cloudflare/src/installation/`,
`docs/reference/provider-bundles.md`.
