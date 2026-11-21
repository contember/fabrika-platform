# Start memory and init connections without the isolation tests

**TLDR.** On 0.9.0-dev.22 a contract application's container init (`fabrika db migrate`, then `fabrika db codegen
--verify`) peaks at about 37–40 MiB anonymous memory and holds 1 database connection at a time. Before the generated
tests were removed, the same init peaked at about 180 MiB (Notes) and 200 MiB (CRM) and held 4 connections. These
numbers were measured locally, by the method that produced the old figures. Nothing was run on Zerops: no
disposable account was available. `ZEROPS_START_MIN_RAM_GB` (0.5) and `ZEROPS_START_CONNECTIONS` (5) still carry the
old values. Lowering either is a separate decision, and it needs the serving process measured too (below).

## What was measured before

- **RAM (2026-10-15, commit 015b41740, `docs/reference/zerops-platform.md`):** measured locally against a throwaway
  `postgres:18` with `/usr/bin/time` and a process-tree sampler, as the summed anonymous RSS of the CLI and its
  `bun test` child during `fabrika db test-isolation`: Notes 161 MiB (38 cases), CRM 225 MiB (133 cases). Zerops
  killed it at the runtime's 0.125 GB floor on 2 of 3 first deploys. That set `ZEROPS_START_MIN_RAM_GB = 0.5`.
- **Connections (2026-10-16, commit 694175b88):** the peak client backends of one `test-isolation` run, measured locally
  against `postgres:18`: 5 with the v0.4.7 test kit, then 4. That set `ZEROPS_START_CONNECTIONS = 5`.

## Method (2026-11-21)

The same method, on one machine (AMD Ryzen 7 PRO 8840HS, Linux 6.17, Bun 1.4.4, `postgres:18` 18.7 in Docker):

- **One cold start** is a fresh database and role family, then the generated init commands in order, run from the
  example's root with `FABRIKA_APP_ID` and a superuser `FABRIKA_APP_DATABASE_URL`, as the generated
  `fabrika/*.generated.sh` scripts run them. Bun's runtime transpiler cache was off
  (`BUN_RUNTIME_TRANSPILER_CACHE_PATH=0`), as in a fresh container. One extra series ran with the cache warm.
- **Memory:** a sampler read `/proc/<pid>/status` of the command's process tree every 10 ms and kept the peak of the
  summed `RssAnon`, the earlier figure. `VmRSS` and GNU time's maximum RSS are recorded beside it.
- **Connections:** Postgres ran with `log_connections` and `log_disconnections`. Peak concurrency is taken from the
  log's millisecond timestamps of every TCP connection opened during the command, the sampler's own excluded. It
  also catches a connection shorter than one sample.
- **Now:** commit 107845797 (main). Its `packages/cli`, `packages/db`, `packages/platform-node` and
  `packages/app/src/build-recipe.ts` are identical to tag `v0.9.0-dev.22` (f6ed97d86).
- **Before, same machine:** commit 53858226d, the parent of e7e82ba2c ("stop generating and requiring access and
  isolation tests"), extracted with `git archive`. Its verify script ran `codegen --verify` and then
  `test-isolation`, and both were measured.
- n = 5 cold starts per example and state. All runs exited 0.

## Results

Peak over the whole init. The steps run one after another, so the peak is the largest step. Median of 5, with the
range in brackets.

| Example | State                      | Peak anonymous RSS, MiB | Peak RSS, MiB       | Peak connections | Connections opened | Init time, s |
| ------- | -------------------------- | ----------------------- | ------------------- | ---------------- | ------------------ | ------------ |
| Notes   | Oct 2026 (v0.4.x, Bun 1.3) | 161                     | n/a                 | 5, then 4        | n/a                | ~1.5 (tests) |
| Notes   | before (53858226d)         | 179.2 [176.6–181.8]     | 253.6 [251.2–256.4] | 4                | 2 + 1 + 26         | 2.72         |
| Notes   | now, cold (dev.22)         | **37.4** [36.8–40.0]    | 70.9 [69.6–73.0]    | **1**            | 2 + 1              | 0.58         |
| Notes   | now, warm cache            | 31.5 [31.1–31.8]        | 65.2 [64.7–65.4]    | 1                | 2 + 1              | 0.50         |
| CRM     | Oct 2026 (v0.4.x, Bun 1.3) | 225                     | n/a                 | 5, then 4        | n/a                | ~1.5 (tests) |
| CRM     | before (53858226d)         | 202.3 [200.8–204.3]     | 277.5 [276.0–279.6] | 4                | 2 + 1 + 66         | 4.98         |
| CRM     | now, cold (dev.22)         | **38.8** [36.5–39.5]    | 71.3 [70.1–72.0]    | **1**            | 2 + 1              | 0.59         |
| CRM     | now, warm cache            | 32.2 [31.8–32.5]        | 65.8 [65.5–66.2]    | 1                | 2 + 1              | 0.51         |

- "Connections opened" is per step: `migrate` + `codegen --verify` (+ `test-isolation`). `migrate` opens the
  provisioning connection, closes it, then opens the migration role's connection, so at most one is open at a time.
  `codegen --verify` opens one provisioning connection.
- Before, the peak was `test-isolation`: two processes, the CLI and its `bun test` child. Its `migrate` and
  `codegen --verify` alone also took about 70 MiB each, against about 37 MiB now.
- Peak RSS adds Bun's mapped binary (about 33 MiB per process) to the anonymous memory. Before, two processes counted
  it twice.

## What this does and does not show

- **Shown:** the init commands' peak fell by about 80 % (Notes 179 → 37 MiB, CRM 202 → 39 MiB). It fits under Zerops'
  0.125 GB (119 MiB) runtime floor with margin, also counting the mapped binary (about 71 MiB). The init needs 1
  connection, not 5. No regression.
- **Not shown:**
  - Nothing ran on Zerops. A container there also holds Zerops' own processes and a page cache, and the October OOM
    was observed there.
  - The serving process pair (launcher and application) starts after the init commands. In October it held about
    105 MiB anonymous for Notes, close to the 0.125 GB floor once the binary is mapped. Whether the 0.5 GB floor can
    drop is therefore decided by the server now, not by the init. The server was not measured here.
- **The constants:** `ZEROPS_START_MIN_RAM_GB = 0.5` (`packages/provider-zerops/src/execution.ts`) and
  `ZEROPS_START_CONNECTIONS = 5` (`packages/provider-zerops/src/database-budget.ts`) and their comments still describe
  the isolation tests. This measurement changes no code. Lowering the connection budget to 1 or 2 would free 3–4
  connections per database. At the 0.25 GB step (`max_connections` 20) that is the difference between 8 and 11–12
  shareable connections. This is a follow-up decision, together with the upgrade path. An existing database's minimum
  RAM is only ever raised, never lowered.

## Reproduce

Throwaway `postgres:18` with `-c log_connections=on -c log_disconnections=on -c "log_line_prefix=%m [%p] %u "`. For
each run: drop and recreate the database and the `*_<app>` roles, then run in the example's root

```sh
FABRIKA_APP_ID=<app> FABRIKA_APP_DATABASE_URL=postgres://postgres:…@127.0.0.1:<port>/<db> \
  /usr/bin/time -f '%M' ./node_modules/.bin/fabrika db migrate        # then: db codegen --verify
```

under a sampler that sums `RssAnon` over the command's process tree (`/proc/*/stat` parent links) every 10 ms and
records its own backend pid. Peak connections come from the Postgres log: the TCP connections whose
`connection received` and `disconnection` fall inside the sampler's own session, the sampler excluded.
