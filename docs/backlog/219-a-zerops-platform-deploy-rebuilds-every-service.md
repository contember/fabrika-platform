---
id: 219
title: A Zerops platform deploy rebuilds every service, and a bring-up compiles Caddy
blocked-by: []
---

# 219 — A Zerops platform deploy rebuilds every service, and a bring-up compiles Caddy

**Summary.** `platform deploy` builds all four services on every run, even when only one changed or only a
variable moved. An iteration on Control waits ~6 min where ~2.5 min would do. A fresh `install` spends ~5 min
compiling Caddy and ~90 s writing variables one process at a time.

## Measurements

A light-tier bring-up on a real account (2026-10-21, commit `d33158e4`), read from the Zerops process list and
the build logs:

| Step                                    | Time               | Note                                                          |
| --------------------------------------- | ------------------ | ------------------------------------------------------------- |
| project create + import of 6 services   | 2 min              | install only                                                  |
| proxy build, pass 1                     | 6:44               | 5:00 of it is `go install caddy@v2.10.2` in `prepareCommands` |
| write 41 variables                      | 91 s               | ~45 sequential `stack.updateUserData` processes, ~2 s each    |
| iam + operations / proxy / control      | 2:24 / 1:27 / 3:00 | pass 2                                                        |
| warm redeploy, only two variables moved | 6:15               | 2:16 / 1:26 / 2:26; all four services rebuilt                 |

One build of `control` or `iam`: the deploy artefact is ~705 MiB (`node_modules` + `packages/` of the whole
monorepo, 217 MiB compressed). Its upload takes 39–46 s and its move into the runtime container ~44 s more. The
readiness check (`retryPeriod: 10s`) adds ~30 s between "listening" and `ACTIVE`.

## Approach / acceptance

In order of payoff for iteration:

1. **Skip a service whose source and variables did not change.** The proxy before Control is a security property
   (the application enforces nothing, ADR-0022), so a skip must never leave Control at a newer version behind an
   older manifest. Acceptance: a deploy that changes only Control's source builds Control alone, and a deploy whose
   manifest changed still builds the proxy before Control.
2. **Ship only the runtime closure of each service.** Deploy one service's production dependencies instead of the
   whole monorepo. Acceptance: the `iam` and `control` artefacts shrink measurably, and every service still boots
   and passes its readiness check on a real account.
3. **Fetch a released Caddy binary** in the proxy's `prepareCommands`, verified by checksum, instead of compiling
   it. It applies to every new installation and every namespace proxy. Acceptance: a fresh proxy build on a real
   account prepares in seconds, and the binary is the pinned 2.10.2.
4. **Write the bootstrap variables in fewer processes**, if the API's bulk replace keeps the `sensitive` flag.
   Verify that on a real account first and record it in `zerops-platform.md`.
5. **Correct the CLI's time estimates.** Pass 1 states "about 4 minutes" (6:44 measured) and pass 2 "about 15
   minutes" (7 min measured).

## Touch points

`packages/provider-zerops/src/installation/deploy.ts`, `install-environment.ts`, `install.ts`,
`topology/setups.ts`, the generated root `zerops.yaml` (`packages/platform-artifacts`),
`docs/reference/zerops-platform.md`.

<!-- Origin: the MCP authoring acceptance bring-up on a real Zerops account. -->
