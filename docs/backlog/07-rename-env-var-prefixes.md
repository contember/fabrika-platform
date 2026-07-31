---
id: 07
title: Implement canonical fabrika environment names with legacy fallback
blocked-by: []
---

# 07 — Implement canonical fabrika environment names with legacy fallback

**Summary.** Implement the canonical names and compatibility policy from
[ADR-0018](../decisions/0018-canonical-fabrika-environment-names.md) across
runtime, authoring, installation, generated configuration, examples, and tests.

## Problem

Phase 0 was deliberately **behaviour-neutral**, so renaming env vars was excluded
from it: an env-var rename is an operational break for every existing deployment,
which is exactly what phase 0 promised not to be. The result is a repo where the
packages say `@fabrika/*` and the runtime says `VOZKA_*`.

ADR-0018 settles both families and the two ownership exceptions:

- `VOZKA_*` → `FABRIKA_CONTROL_*`;
- `PROPUSTKA_*` → `FABRIKA_IAM_*`;
- `PROPUSTKA_APP_ID` → `FABRIKA_APP_ID`;
- `VOZKA_WORKSPACE` → `FABRIKA_RUNNER_WORKSPACE`.

The legacy inputs remain supported through canonical-first dual reads. Durable
app IDs, deployed resource names, storage identities, and migration identities
listed in ADR-0018 are explicitly outside this sweep.

## Approach / acceptance

Add a shared compatibility reader where the runtime boundary permits it; keep
package-specific environment types explicit. For every migrated name, test
canonical-only, legacy-only, both, and neither. Canonical values win. Legacy
reads warn once without logging a value. Writers and generated configuration
emit canonical names only.

Acceptance: every in-scope environment input follows ADR-0018; all generated and
documented configuration uses canonical names; legacy strings remain only in
compatibility code, compatibility tests, immutable history, and explicit
deprecation documentation. Tests prove that the persistent identities listed in
ADR-0018 do not change.

## Touch points

`@fabrika/control`, `@fabrika/engine`, `@fabrika/cli`, `@fabrika/iam`,
`@fabrika/auth`, runner packages, provider installation packages, deployment
configs, examples, and reference docs.
