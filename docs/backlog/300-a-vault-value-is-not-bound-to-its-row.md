---
id: 300
title: A vault value is not bound to its row
blocked-by: []
---

# 300 — A vault value is not bound to its row

**Summary.** The vault's envelope carries no associated data, so a sealed value moved into another row opens there.
Deferred by decision 2026-11-23. P3, size M.

## Problem

`seal` and `open` in `packages/control/src/vault.ts` encrypt a value and wrap its data key with AES-256-GCM and no
associated data. What ties a value to its application and name is the row's `scope` and `label`, which
`getSecretForPurpose` checks on every read. A writer of Control's database who has no KEK can copy one row's
`ciphertext`, `value_iv`, `wrapped_dek` and `dek_iv` into another application's row, and the vault then hands that
application the other's secret. Such a writer can already change the registry, the published snapshots and the runs,
so the gain is small, which is why it is deferred.

## Approach / acceptance

Pass the row's `scope` and `label` (and its `id`) as GCM associated data when a value is sealed and opened, and re-seal
every existing row in a migration step that runs with the KEK (with Control stopped, like
`packages/control/src/bun/rotate-vault-key.ts`). Decide whether the re-seal and a KEK rotation share one run.

Witness: a vault test that a value copied into another row fails to open there, on SQLite and on Postgres.

## Touch points

`packages/control/src/vault.ts`, `packages/control/src/bun/rotate-vault-key.ts`,
`docs/reference/security-runtime.md` (§6), `docs/reference/key-rotation.md`.

<!-- Origin: a security review of the installation documentation. -->
