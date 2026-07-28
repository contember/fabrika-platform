---
id: 16
title: Build the config manifest ADR-0005 specifies
blocked-by: []
---

# 16 — Build the config manifest ADR-0005 specifies

[ADR-0005](../decisions/0005-compile-app-config-to-static-manifest.md) decides that
a `fabrika build` step emits `fabrika.manifest.json` and the control plane reads
static JSON, so it **never executes app code**.

## Problem

The manifest does not exist anywhere in the repo. `ZeropsAppTarget.services` is a
**function**, mirroring Cloudflare's `resources()` — so a control plane that
materialised it would be executing a stranger's TypeScript with platform
credentials in scope, which is the exact risk ADR-0005 was written to remove. The
risk is currently latent only because nothing calls it outside the driver.

The Zerops driver was built manifest-ready: `compileImport()` takes a target plus a
context and returns plain data, so `fabrika build` can emit the compiled
`ZeropsImportDocument` and `open()` can read it instead of calling `services(ctx)`.

## The cost ADR-0005 already records

`pipeline.vars` are injected into `process.env` _before_ the config is materialised,
so a static manifest cannot bake them — they become `${VAR}` placeholders
interpolated at deploy time. That narrows the config from arbitrary code to
declarative data with interpolation. Confirm that every existing config still fits
before committing to it.

## Acceptance

The control plane can deploy an app without importing or evaluating anything from
the app's repository; a drift check fails when the manifest disagrees with the
config it came from.
