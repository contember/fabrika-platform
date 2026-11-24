---
id: 301
title: Framework secrets stay in a process's initial environment
blocked-by: [./198-an-in-container-env-write-may-reach-another-services-credentials.md]
---

# 301: Framework secrets stay in a process's initial environment

**Summary.** `captureEnvironment` takes the framework's variables out of `process.env` and `Bun.env`, but on Linux the
process's initial environment block, `/proc/self/environ`, still holds them, and code in the same process can read it.
Medium; framework-wide, so it needs a design before code.

## Problem

`captureEnvironment` (`packages/app/src/implement/environment.ts`) deletes every `FABRIKA_*` variable, and the
container credentials endpoint's `AWS_CONTAINER_*` ones, from `process.env` and `Bun.env` before the application
loads. That keeps them out of a dependency that copies or dumps the environment. It does not take them out of the
initial environment block the kernel exposes as `/proc/self/environ`, which `unsetenv` does not rewrite.

Measured on 2026-11-24 in `oven/bun:1.4.4` as uid 1000, pid 1: after the delete, `process.env` holds neither
`AWS_CONTAINER_CREDENTIALS_RELATIVE_URI` nor a `FABRIKA_APP_STORAGE_SECRET_ACCESS_KEY`, and `/proc/self/environ` holds
both. So every framework secret the serving process gets as a variable (static storage keys, workload keys, token keys,
the proxy secret, the runtime database URL, and in container mode the task's credentials path) is readable by
application code that reads that file. That is within the stated model (the data layer and the capture stop honest
mistakes, not code in the same process), but the capture's comments promised more than that.

## Approach / acceptance

[ADR-0082](../decisions/0082-framework-secrets-reach-the-application-only-through-its-launcher.md) proposes
the design and is not decided: the launcher re-executes in place over a `memfd` handover, or spawns the runtime with
the handover on an inherited descriptor, under `PR_SET_NO_NEW_PRIVS`; the alternatives are weighed there. **On Zerops
it waits for backlog 198's remedy 2**: the application has `sudo` there, which reads any process's environment,
non-dumpable or not.

Acceptance (the ADR's spike): in a Linux container, a framework secret is in neither `process.env` nor
`/proc/self/environ` of the process that loads the application; `sudo -n true` fails in it; no other process of its
uid reads its environment or an ancestor's.

## Touch points

- `packages/app/src/implement/environment.ts`, `packages/app/src/bun.ts` (`relaunchAsRuntime`, `serveContract`,
  `runContractJob`), `packages/app/src/undumpable.ts`
- `docs/reference/application-runtime.md`, `packages/app/CLAUDE.md`
