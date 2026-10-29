---
id: 251
title: The dev launcher runs authored commands as root with the app's secrets
blocked-by: []
---

# 251 — The dev launcher runs authored commands as root with the app's secrets

**Summary.** In a dev sandbox the bootstrap build runs as an unprivileged user with a clean environment, but after it
the launcher runs the authored SPA commands of each `apply_changes` and the check chain of `run_checks` as root, with
the launcher's whole environment. Medium.

## Problem

The sandbox's launcher (`packages/provider-zerops/sandbox/bin/run-launcher.sh`, `packages/app/src/dev/launcher.ts`) runs
as root with the environment file sourced: the application's secrets, the proxy secret, the database's provisioning
credential and the workspace's `source` key. On a sync that changes a web source it runs the authored SPA commands, and
on `run_checks` the tests, `tsc` and `fabrika-check`, as children of itself. That code is an unreviewed workspace head,
and it can read every value of that environment and the root-only files of the sandbox. The bootstrap's build does
not, because `run-build.sh` drops to `fabrika-build` with `env -i`.

## Approach / acceptance

Run the SPA commands and the check chain as the build user with a clean environment, as `run-build.sh` runs the build,
and hand them only what they need. Test: in a sandbox, an SPA command and a test that print the environment show no
value of the launcher's environment file, and cannot read the file.

## Touch points

- `packages/provider-zerops/sandbox/bin/run-launcher.sh`
- `packages/app/src/dev/launcher.ts`
- `packages/provider-zerops/src/sandbox/dev-artifact.ts`
