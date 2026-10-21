---
id: 203
title: Deleting an app or an environment leaves its secrets and IAM keys
blocked-by: []
---

# 203 — Deleting an app or an environment leaves its secrets and IAM keys

**Summary.** `deleteApp` and `deleteAppEnv` cascade the rows that point into the vault, not the vault rows, and they
revoke nothing in IAM. The ciphertext stays without an owner and the environment's IAM keys stay valid until they
expire. P3, size M.

## Problem

`deleteApp` and `deleteAppEnv` (`packages/control/src/db/registry.ts:251-269`, `:876-888`) delete the `apps` or
`app_envs` row in one batch. `ON DELETE CASCADE` then removes every row with a `value_ref` into the vault:
`app_secrets` (`migrations/0001_init.sql:118`), `app_env_proxy_secrets` (0004), the workload credentials (0006, 0008,
0011), `app_env_membership_keys` (0007), `app_env_token_keys` (0012) and `platform_transport_keys` (0013). The `vault`
rows they named stay: nothing references them, nothing lists them and nothing deletes them.

IAM is not told either:

- The environment's workload (connector) keys and its membership key stay valid in IAM until their expiry,
  `MAX_KEY_LIFETIME_SECONDS` (30 days, `packages/auth-core/src/rpc.ts:184`). Without a route to the deleted
  environment the proxy mints nothing for them, so a holder reaches nothing; they are still live credentials.
- An app delete leaves the app's registered schema (its vocabulary) and its grants in IAM.

The use cases (`packages/control/src/api/registry/apps.ts:48-66`, `environments.ts:148-166`) audit, notify the
catalog and republish namespace proxies, and call nothing in IAM. This hits Cloudflare and the local stack on every
delete; on Zerops the claims check refuses most deletes first (backlog 87).

## Approach / acceptance

1. **New deletes.** In the same batch, before the cascading delete, delete the vault rows the cascading tables name
   (`DELETE FROM vault WHERE id IN (SELECT substr(value_ref, 7) FROM … WHERE app_id = ? [AND env = ?])`, one per
   table; `vault:` is the ref prefix, `packages/control/src/vault.ts:198-206`). Same SQL on D1 and Postgres. Witness:
   a registry test on both dialects that the vault is empty after deleting an app that held a secret, a proxy secret
   and each credential kind.
2. **Existing orphans.** A one-time maintenance step or migration deletes every vault row that no `value_ref` names.
   It must know every referencing column, including the GitHub connection refs; a test lists them from the
   migrations so a new one cannot be missed.
3. **IAM.** After the delete, call `workloads.revokeKeys` for each workload of the environment, and add a revocation
   for its membership key (IAM has `membershipKeys.issue` only). Or decide that a key without a route expires on its
   own and write that down in ADR-0022 or the reference. Decide whether an app delete removes its IAM schema and
   grants, or leaves them for a re-registration.

Rollout on an existing installation: item 2 cleans what earlier deletes left; items 1 and 3 change only new deletes.

## Touch points

`packages/control/src/db/registry.ts`, `packages/control/src/api/registry/apps.ts`,
`packages/control/src/api/registry/environments.ts`, `packages/control/src/workload-credentials.ts`,
`packages/control/src/membership-transport.ts`, `packages/iam/src/admin/rpc.ts`, `packages/iam-contract/src/index.ts`.

<!-- Origin: a platform review. -->
