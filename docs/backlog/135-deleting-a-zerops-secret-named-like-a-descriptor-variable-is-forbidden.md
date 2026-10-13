---
id: 135
title: Deleting a Zerops secret named like a descriptor variable is forbidden
blocked-by: []
---

# 135 — Deleting a Zerops secret named like a descriptor variable is forbidden

**Summary.** On Zerops, deleting an app secret can hit `userDataDeleteForbidden` when the secret has the name of a
variable in the application's own `run.envVariables`: the delete takes the first `/env` record with that key, which
can be the deployed version's variable. Effort: S; verify on a live account first.

## Problem

- `secrets.delete` (`packages/provider-zerops/src/control.ts:470`–`:478`) lists `/service-stack/{id}/env` and deletes
  the first record whose key is the secret's name.
- Since 2026-10-13 `/env` also lists a deployed version's `run.envVariables` as `USER` records of the same shape, and
  `DELETE /user-data/{id}` on one answers 400 `userDataDeleteForbidden`
  (`docs/reference/zerops-platform.md:269`–`:274`). `c732b94e` removed the same delete for `FABRIKA_RELEASE`.
- So a secret whose name the application's `zerops.yaml` also sets can resolve to the descriptor's record. The delete
  fails, and `deleteAppSecretValueUseCase` (`packages/control/src/api/vault.ts:135`–`:156`) answers an error and
  records no audit row.
- The create-or-update fallback (`packages/provider-zerops/src/api/client.ts:439`–`:446`) assumes a descriptor
  variable never appears in `/env`. That no longer holds, so a put of such a name may `PUT` the descriptor's record.
  Not verified.

Found while the 0.3 release fixes were integrated.

## Approach / acceptance

- Verify on a live account whether a service variable and a descriptor variable of one key can coexist, and whether
  any field of `/env` tells them apart. Record it in `docs/reference/zerops-platform.md` and `platform-facts.ts`.
- Then either refuse the overlap (Control refuses a secret whose name the deployed descriptor's `run.envVariables`
  sets, and a deploy whose descriptor sets a secret's name), or delete and update only the service variable's record.
- Witness: the Zerops emulator lists a descriptor variable beside a secret of the same name; deleting the secret
  answers a named refusal or deletes the secret, never `userDataDeleteForbidden` from Zerops.

## Touch points

`packages/provider-zerops/src/{control.ts,api/client.ts}`, `packages/provider-zerops/src/__tests__/platform-facts.ts`,
`packages/local-stack/src/zerops-emulator.ts`, `packages/control/src/api/vault.ts`,
`docs/reference/zerops-platform.md`.

<!-- Origin: integrating the 0.3 release fixes into main after the paved-road sprint (c732b94e). -->
