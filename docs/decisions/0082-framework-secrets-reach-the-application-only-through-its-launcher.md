---
id: 0082
title: Framework secrets reach the application's process only through its launcher
status: proposed
date: 2026-11-24
---

# 0082: Framework secrets reach the application's process only through its launcher

**Proposal, nothing built.** It answers [backlog 301](../backlog/301-framework-secrets-stay-in-the-initial-environment.md).
**On Zerops it is worth nothing until remedy 2 of
[backlog 198](../backlog/198-an-in-container-env-write-may-reach-another-services-credentials.md) lands** (the
application runs as a dedicated user without `sudo`), so 198 comes first. Facts marked UNVERIFIED are for the spike
in Consequences to settle before any code depends on them.

## Context

The platform hands an application's serving process and its job runs their framework variables as environment
variables (the platform protocol, ADR-0062). Several are secrets:

- the runtime database URL, and for a database application on Zerops the provisioning one;
- the storage keys (static mode), or the ECS container credentials path (container mode);
- the token keys and the proxy secret;
- the job and webhook keys (`FABRIKA_JOB_*_KEY`, `FABRIKA_WEBHOOK_*_KEY`) and the IAM RPC key;
- each import's connect key.

`captureEnvironment` (`packages/app/src/implement/environment.ts`) copies them into a frozen record and deletes them
from `process.env` and `Bun.env` before any application module loads. On Linux the process's initial environment
block, `/proc/self/environ`, keeps them: measured on 2026-11-24 in `oven/bun:1.4.4` as uid 1000.

The launcher already exists for the provisioning credential (`relaunchAsRuntime` in `packages/app/src/bun.ts`):

- a process that holds it loads no application module and derives the runtime credential;
- it makes itself non-dumpable (`prctl(PR_SET_DUMPABLE, 0)`);
- it runs the same command again without the provisioning credential, inheriting stdio, forwarding signals and taking
  over the child's exit.

Non-dumpable keeps a process of the same uid out of its `/proc/<pid>/environ` and memory. It does not keep out a
holder of `CAP_SYS_PTRACE`.

**What each runtime gives today:**

- **Zerops.** The application runs as `zerops`, which has passwordless `sudo`, and `sudo` reads a non-dumpable
  process's environment (measured 2026-10-21, [Zerops platform facts](../reference/zerops-platform.md)). So
  application code reads the launcher's environment, the provisioning credential included, with
  `sudo cat /proc/$PPID/environ`. It also reads the environment of whatever ancestor started the service (UNVERIFIED:
  the supervisor above the start script). Backlog 198 gives in-container code the project's other credentials by
  another route (`zsc set-env`), which no launcher touches.
- **AWS (ECS on Fargate).** The image runs as a non-root `USER` (`containerImage` refuses root). Docker's default
  capability set has no `CAP_SYS_PTRACE` (UNVERIFIED for Fargate's). ECS writes `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`
  itself.
- **Cloudflare.** There is no process and no `/proc`. The object receives its bindings and variables as `env`, and
  `cloudflare:workers` exports that `env` to any module of the Worker (UNVERIFIED here, per Cloudflare's
  documentation). Under plain `nodejs_compat` with a compatibility date from 2025-04-01, workerd also fills
  `process.env` with the text variables and secrets at module evaluation, before the object's boot captures anything
  (measured in workerd 1.20260312.1). The provider's default, `nodejs_compat_v2`, leaves it empty; an author's own
  flags and the proxy Worker's did not, which #370 closes for both (item 4).

## Decision

Proposed, in this order:

1. **Zerops first runs the application without `sudo`** (backlog 198, remedy 2). Until then, nothing below changes
   what application code on Zerops can read. The uid switch is the start script's and the crontab's, not the
   launcher's: they run the launcher as the dedicated user with `sudo --preserve-env=<the service's variables> -u
   <user> --`, so the framework variables cross that one `sudo` (UNVERIFIED: that Zerops' sudoers grants `zerops` a
   rule of `ALL`, under which `SETENV` is implied). The launcher then starts as the application's user, holds no
   privilege to drop, and A′ below applies as written. A launcher that switched the uid itself would need `sudo` from
   framework code, would have to set `PR_SET_NO_NEW_PRIVS` only after the switch, and would lose the `memfd` to
   `sudo`'s `env_reset` and `closefrom`.
2. **The launcher re-executes in place (A′)**, if the spike shows it sound, with a spawned child as the fallback (A).
   The launcher runs first in `serveContract` and `runContractJob`, whether or not it holds the provisioning
   credential. It reads the framework variables (every `FABRIKA_*` name and `CONTAINER_CREDENTIAL_VARIABLES`), derives
   the runtime credential when it holds the provisioning one, and sets `PR_SET_NO_NEW_PRIVS`. That flag is inherited
   across `fork` and `execve`, so nothing the application starts gains privileges through a setuid binary. It is not
   enough on its own: the crontab and the init commands do not descend from the launcher, and they run files the
   application's user can write, which is why item 1 comes first.
   - **A′:** it writes the variables, as one JSON object, to a `memfd` without close-on-exec, then `execve`s the same
     command (`bun:ffi`, Linux only) with the environment minus every framework variable, plus the marker
     `FABRIKA_HANDOVER_FD`. There is one process: no second process holds the original environment or the
     provisioning credential, no signal is forwarded, and on ECS the application stays the task's main process.
   - **A:** it spawns the same command with that environment and the descriptor as `stdio[3]`. It installs signal
     forwarding before writing, writes until every byte is out (a short write is possible: macOS wrote 8192 of
     100013 bytes in review), closes its end and stays as today, non-dumpable. Not Bun's `ipc` channel, which stays
     open both ways for the child's whole life.
3. **The runtime sets `PR_SET_DUMPABLE 0` on itself, then reads the handover, then closes it**: read to the end,
   then the size bound, then the parse, and the captured record built from it. Non-dumpable first, so no process of
   the same uid reads its memory or the open descriptor, and no core dump holds the record. Under A′, `execve` makes
   the new image dumpable again, so between the exec and that first statement the `memfd` is reachable at
   `/proc/<pid>/fd/<n>` for a process of the same uid. Once item 1 has landed, every such process is this application,
   which receives the same secrets anyway, so the window is accepted. A marker without a readable, well-formed handover
   is a `BootError`. So is any framework variable in its own environment other than the marker.
4. **Cloudflare:** measured in workerd 1.20260312.1, `nodejs_compat_v2` (the provider's default) leaves `process.env`
   empty, while plain `nodejs_compat` from 2025-04-01 fills it. #370 makes the provider always set
   `nodejs_compat_do_not_populate_process_env` on every application Worker and its proxy, and refuse an authored
   opt-in; #371 sets it on Control's Worker and the runner Worker (both open when this was written).
   `cloudflare:workers` joins the checker's `env-read` rule for application code.

**What this buys, and what it does not.** A careless dependency or a diagnostic dump that reads the environment no
longer sees a framework secret, and a process of the same uid reads none of them. It is no defence against a hostile
dependency, on any runtime:

- code in the process can take a heap snapshot (`Bun.generateHeapSnapshot()`), patch `crypto` or `fetch` before
  their first use, or load the framework's modules;
- the checker skips `node_modules`, so neither `env-read` nor the `cloudflare:workers` rule sees a dependency;
- the application's own secrets stay in its environment by design;
- on Zerops, variables the platform itself writes (`ZEROPS_CertKey`, `ZEROPS_CertCrt`) are not framework variables
  and stay. Whether the launcher withholds them depends on what the serving process needs (the spike lists them).

**The limit, per runtime, once this is built:**

| Runtime    | Who can still read a framework secret                                                                                        |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Zerops     | Code in the process, and the platform's own root tooling. Same uid: no, but only once backlog 198 remedy 2 removes `sudo`    |
| AWS        | Code in the process. A holder of `CAP_SYS_PTRACE` in the task, which the default set does not grant (UNVERIFIED for Fargate) |
| Cloudflare | Code in the isolate, through the bindings' `env` (`cloudflare:workers`), which no runtime change hides                       |

## Consequences

- **Zerops:** blocked on backlog 198 remedy 2, which changes the generated start script (a platform release, at each
  application's next deploy). With A′, no extra process. With A, a database application keeps its two processes, and
  one without a database gains the launcher, in every container and job run.
- **AWS:** with A′, ECS's SIGTERM reaches the drain directly. With A, the launcher forwards it, as today. The container
  credentials path crosses in the handover, and `containerCredentials` keeps refreshing from it.
- **Cloudflare:** the `process.env` flag is its own provider change, with its own rollout note: each Worker gets it at
  its next deploy. The checker rule reaches an application with its minor's next `@fabrika/check` patch.
- **Rollout of an existing installation:** for the launcher, none. The platform writes the same variables, and the
  handover is between two images of one framework release. An application gets it when it raises its pin; an older
  release keeps the documented limit (ADR-0062).
- **The spike** (Linux container, Bun as deployed) settles:
  - A′: `execve` through `bun:ffi` from a running Bun (other threads, Bun's own descriptors close-on-exec, the `memfd`
    surviving the exec), and the development fallback;
  - A, already measured in review: Bun 1.4.4 passes `stdio[3]` and the child reads it by number; only the extra
    process's memory remains;
  - `PR_SET_NO_NEW_PRIVS`: that the prepare and init commands and the crontab's own `sudo` (they do not descend from
    the launcher) still work;
  - on Zerops: the serving process's ancestry (`ps -o pid,ppid,user,args`) and whether an ancestor keeps the service
    environment, and the non-framework variables the serving process holds;
  - Fargate's capability set;
  - that Zerops' sudoers lets `zerops` keep the variables across `sudo -u`, with a list the start script builds per
    deploy (the `FABRIKA_JOB_*`, `FABRIKA_WEBHOOK_*`, `FABRIKA_PROCEDURE_*` and `FABRIKA_CONNECT_*` names vary with the
    contract), and what `sudo`'s `secure_path` and its reset of `HOME` change for the launcher's `PATH` and Bun's cache;
  - the acceptance probe: no framework secret in the runtime's `process.env` or `/proc/self/environ`; `sudo -n true`
    fails in it; no other process of its uid reads its environment or that of an ancestor.
- **Docs on shipping:** the capture's comments, `packages/app/CLAUDE.md` and `docs/reference/application-runtime.md`;
  backlog 301 is deleted.

## Alternatives considered

- **A, a spawned child**, the fallback above. It costs a process per container and job run, and signal forwarding.
  Its launcher keeps the original environment (non-dumpable), so on Zerops it also waits for backlog 198.
- **B, a holding parent that keeps the secrets and answers the child's requests**: credentials, signatures, the
  workload token exchange. A secret the child only signs with would never enter it. It loses on four counts:
  - the child still needs the database URL, the proxy secret, the token keys and the connect keys raw;
  - every S3 request and token exchange becomes an IPC round trip;
  - it adds a long-lived second process with a versioned protocol;
  - Cloudflare has no equivalent.
- **C, the platform writes the secrets to a file**: it changes the platform protocol (ADR-0062), needs a secret-file
  mechanism per provider (UNVERIFIED for Zerops), and cannot cover ECS's own `AWS_CONTAINER_*` variables.
- **D, overwriting the initial environment block in place**: `PR_SET_MM_ENV_START/END` needs `CAP_SYS_RESOURCE`, and
  writing over `envp` through `bun:ffi` depends on Bun's memory layout.
- **E, keep the capture and the documented limit**: honest and free; the answer if the spike rejects A′ and A's cost
  is judged too high.
- **F, the launcher drops to another uid before exec**: that needs root or `sudo` in framework code, `sudo` resets the
  environment and closes the `memfd`, and `PR_SET_NO_NEW_PRIVS` could only follow the switch. With a uid switch inside
  it, A would be stronger (the application could not read a launcher of another uid at all), but the switch belongs to
  the start script (item 1), where it covers the crontab too. On ECS the image already runs as a non-root user.
