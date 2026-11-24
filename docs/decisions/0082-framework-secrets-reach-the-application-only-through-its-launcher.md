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
  documentation). Under `nodejs_compat` with a compatibility date from 2025-04-01, workerd may also fill
  `process.env` with the text variables and secrets at module evaluation, before the object's boot captures anything
  (UNVERIFIED; the provider's defaults are `nodejs_compat_v2` and `2025-10-01`). If it does, the capture's promise
  does not hold on Cloudflare today.

## Decision

Proposed, in this order:

1. **Zerops first runs the application without `sudo`** (backlog 198, remedy 2). Until then, nothing below changes
   what application code on Zerops can read.
2. **The launcher re-executes in place (A′)**, if the spike shows it sound, with a spawned child as the fallback (A).
   The launcher runs first in `serveContract` and `runContractJob`, whether or not it holds the provisioning
   credential. It reads the framework variables (every `FABRIKA_*` name and `CONTAINER_CREDENTIAL_VARIABLES`), derives
   the runtime credential when it holds the provisioning one, and sets `PR_SET_NO_NEW_PRIVS`. That flag is inherited
   across `fork` and `execve`, so nothing the application starts gains privileges through a setuid binary.
   - **A′:** it writes the variables, as one JSON object, to a `memfd` without close-on-exec, then `execve`s the same
     command (`bun:ffi`, Linux only) with the environment minus every framework variable, plus the marker
     `FABRIKA_HANDOVER_FD`. There is one process: no second process holds the original environment or the
     provisioning credential, no signal is forwarded, and on ECS the application stays the task's main process.
   - **A:** it spawns the same command with that environment and the descriptor as `stdio[3]`. It installs signal
     forwarding before writing, writes until every byte is out (a short write is possible: macOS wrote 8192 of
     100013 bytes in review), closes its end and stays as today, non-dumpable. Not Bun's `ipc` channel, which stays
     open both ways for the child's whole life.
3. **The runtime reads the handover before anything else**: to the end, then the size bound, then the parse. It
   closes the descriptor, builds the captured record from it, and sets `PR_SET_DUMPABLE 0` on itself, so no process
   of the same uid reads its memory and no core dump holds the record. A marker without a readable, well-formed
   handover is a `BootError`. So is any framework variable in its own environment other than the marker.
4. **Cloudflare:** if the spike finds `process.env` filled, the generated Worker sets
   `nodejs_compat_no_populate_process_env`. In both cases, `cloudflare:workers` joins the checker's `env-read` rule
   for application code.

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
- **Cloudflare:** the flag, if needed, is a provider change. A deploy writes the Worker's compatibility flags, so an
  existing application gets it at its next deploy, and the provider PR states that rollout. The checker rule reaches
  an application with its minor's next `@fabrika/check` patch.
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
  - Fargate's capability set, and `process.env` in a Cloudflare object under the provider's defaults;
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
- **F, the launcher drops to another uid before exec**: that needs root or `sudo`. On Zerops it is backlog 198
  remedy 2's job, in the start script; on ECS the image already runs as a non-root user.
