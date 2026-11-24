---
id: 0082
title: Framework secrets reach the application's process only through its launcher
status: proposed
date: 2026-11-24
---

# 0082: Framework secrets reach the application's process only through its launcher

**Proposal.** Nothing here is built. It answers [backlog 301](../backlog/301-framework-secrets-stay-in-the-initial-environment.md)
and waits for a decision between the options below. Facts marked UNVERIFIED are to be settled by the spike named in
Consequences before any code depends on them.

## Context

The platform hands an application's serving process and its job runs their framework variables as environment
variables (the platform protocol, ADR-0062). Several are secrets:

- the runtime database URL;
- the storage keys (static mode), or the ECS container credentials path (container mode);
- the token keys and the proxy secret;
- the job and webhook keys (`FABRIKA_JOB_*_KEY`, `FABRIKA_WEBHOOK_*_KEY`) and the IAM RPC key;
- each import's connect key.

`captureEnvironment` (`packages/app/src/implement/environment.ts`) copies them into a frozen record and deletes them
from `process.env` and `Bun.env` before any application module loads. On Linux that leaves the process's initial
environment block, `/proc/self/environ`, which `unsetenv` does not rewrite. Measured on 2026-11-24 in `oven/bun:1.4.4`
as uid 1000: after the delete, `/proc/self/environ` still holds `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI` and
`FABRIKA_APP_STORAGE_SECRET_ACCESS_KEY`. A dependency that reads that file, a diagnostic dump that includes it, or a
process of the same user reading `/proc/<pid>/environ` sees every framework secret.

**The threat model stays what it is.** The capture, the data layer and the checker stop honest mistakes and careless
dependencies, not hostile code in the same process. Such code can load any module of the framework by URL and read
what the process holds in memory. So the goal is narrow: no framework secret readable from the application process's
environment, `/proc/self/environ` included, as `process.env` is already clean.

**A mechanism for half of this exists.** When a serving or job process holds the provisioning database credential
(`FABRIKA_APP_DATABASE_URL`, which a Zerops deploy writes for an application with a database), it is a launcher
(`relaunchAsRuntime` in `packages/app/src/bun.ts`):

- it loads no application module;
- it derives the runtime credential;
- it makes itself non-dumpable (`makeProcessUndumpable`, `prctl(PR_SET_DUMPABLE, 0)`), so a process of the same user
  cannot read its `/proc/<pid>/environ` or memory;
- it runs the same command again with an environment that carries the runtime credential instead of the provisioning
  one, inheriting stdio, forwarding signals and taking over the child's exit.

That child's `/proc/self/environ` lacks the provisioning credential, but still holds every other framework secret.

The runtimes differ:

- **Zerops:** a Bun container; the crontab runs `fabrika job run <name>`. An application with a database is already
  relaunched; one without (`defineApp(vocabulary)`, no tables) is not.
- **AWS (ECS on Fargate):** the same Bun recipe in an image ([the AWS idea](../ideas/aws-provider.md)), with the
  schedule in the serving process (ADR-0080). ECS writes `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI` itself, so the
  platform cannot choose to leave it out of the environment.
- **Cloudflare:** no process and no `/proc`. The object receives its bindings and variables as `env` (ADR-0065),
  which `captureEnvironment` reads the same way. The analogue of the initial environment is the module-level `env`
  that `cloudflare:workers` exports to any module of the Worker (UNVERIFIED here, per Cloudflare's documentation). The
  checker does not refuse that import today; the framework itself does not use it (`cloudflare/application.ts`).

## Decision

Proposed: **option A, every Bun serving and job process re-executes itself, and its framework variables cross over
an inherited descriptor.**

1. The generated entrypoint's first act, in `serveContract` and `runContractJob` alike, is the launcher, whether or not
   it holds the provisioning credential. The launcher:
   - reads the framework variables (every `FABRIKA_*` name and `CONTAINER_CREDENTIAL_VARIABLES`) from its own
     environment;
   - derives the runtime database credential when it holds the provisioning one, as today;
   - makes itself non-dumpable;
   - spawns the same command with the environment minus every framework variable, plus one marker that names the
     descriptor (`FABRIKA_HANDOVER_FD`, a non-secret number);
   - writes the variables to the descriptor once, as one JSON object, and closes its end.

   It still loads no application module, forwards signals, inherits stdio and exits as the child exits.
2. The child is the runtime when the marker is set. Before anything else it reads the descriptor to its end, under a
   size bound, closes it and builds the captured record from it. `process.env` keeps only the application's own
   variables, and the initial environment never held a framework one. A marker without a readable, well-formed
   handover is a `BootError`. A framework variable in the child's own environment is a `BootError` too, because
   something put it there that the launcher did not.
3. The record, the scrubber, crash reports and every reader of the framework variables are unchanged. They read the
   record, never `process.env`.
4. Cloudflare gets the analogue the checker can give: `cloudflare:workers` joins `env-read` (or `forbidden-import`) for
   application code. This is a checker rule against honest mistakes, like the rest of `env-read`.
5. The stated limit becomes: a framework secret is in the child's memory and in the launcher's initial environment.
   The launcher is non-dumpable, so a process of the same user reads neither. Root in the container reads both, and
   code in the child can find what the child holds.

## Consequences

- **Zerops.** A database application keeps its two processes, with the handover replacing the second environment. An
  application without a database gains the launcher process: its memory (UNVERIFIED: about one idle Bun process) is
  paid in every container and in every job run. The crontab's commands do not change.
- **AWS.** The launcher is the task's main process and receives ECS's SIGTERM. It forwards it as today, so the
  ADR-0080 drain runs in the child. The child gets the container credentials path through the handover; `containerCredentials` keeps refreshing from it.
  The provider renders no new command. Whether the task should also set `initProcessEnabled` (an init that reaps
  orphans; the application spawns none, by the checker's `child_process` rule) is for the provider PR.
- **Cloudflare.** The runtime is unchanged. The checker rule needs a release of `@fabrika/check`, and the platform runs
  the newest patch of the application's own minor, so it reaches an application on that minor's next patch.
- **Rollout of an existing installation.** None.
  - No generated file, environment variable or provider state changes, since the platform writes the same variables.
  - The handover is between two processes of one framework release: the same entrypoint and the same installed
    package, so the two sides cannot differ in version.
  - An application gets the change when it raises its framework pin. An application on an older release keeps the
    documented limit, and no platform release has to serve anything new for it (ADR-0062).
- **The spike before code** (Linux container, Bun as deployed) settles three things:
  - whether `Bun.spawn` passes an extra pipe descriptor to the child (an `stdio` entry past the third), and whether
    the child reads it by number; if not, the handover uses Bun's `ipc` channel instead, and the marker names that;
  - the extra process's resident memory;
  - backlog 301's acceptance probe: no framework secret in the child's `process.env` or `/proc/self/environ`, and the
    launcher's `/proc/<pid>/environ` unreadable by the same uid.
- Tests: `launcher.test.ts` gains the handover, the marker refusals and a database-less application. The probe runs
  where the container suites run.
- Docs on shipping: the `captureEnvironment` comments, `packages/app/CLAUDE.md`, `docs/reference/application-runtime.md`;
  backlog 301 is deleted.

## Alternatives considered

- **B: a holding parent that keeps the secrets and answers the child's requests**: credentials, signatures, the
  workload token exchange. Its strength is that a secret the child only signs with (static storage keys, the task
  role's credentials, the job keys) never enters the child, so hostile code could use it while it runs but not
  exfiltrate it. It loses on four counts:
  - the child still needs several secrets raw: the runtime database URL to open its pool, the proxy secret compared
    on every request, the token keys for every HMAC, and the connect keys as bearers. Moving those would turn the
    parent into a database proxy and a per-request hop;
  - every S3 request and token exchange becomes an IPC round trip;
  - it adds a long-lived second process, with a versioned protocol between the two and its own failure and restart
    semantics;
  - on Cloudflare it has no equivalent at all.

  It stays possible later, on top of A, for the task role's credentials alone, if a deployment's role grants more
  than its bucket.
- **C: the platform writes the secrets to a file instead of the environment** (a secret mount the launcher reads and
  deletes). It changes the platform protocol, which every framework release in the support window must keep being
  served (ADR-0062). It needs a secret-file mechanism on each provider (UNVERIFIED for Zerops), and it cannot cover
  ECS's own `AWS_CONTAINER_*` variables. A keeps the protocol and covers those.
- **D: overwrite the initial environment block in place.** `prctl(PR_SET_MM_ENV_START/END)` needs `CAP_SYS_RESOURCE`,
  which an application container does not have. Writing over the strings through `bun:ffi` writes into memory the
  runtime may still read, and depends on where Bun keeps `envp`. Fragile either way.
- **E: keep the capture and the documented limit** (the state since the storage connection change). It costs nothing
  and stays honest. It is the answer if A's cost (a process per container and job run) is judged too high for what it
  closes.
