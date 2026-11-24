---
id: 301
title: Framework secrets stay in a process's initial environment
blocked-by: []
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

Decide between, for example:

- the serving process re-executing itself without the framework's variables and handing them to the child over an
  inherited descriptor it reads once at boot and closes, as `relaunchAsRuntime` already re-executes without the
  provisioning credential;
- or keeping a small parent that holds the secrets and answers the child's requests (credentials, signatures), so the
  child never holds them at all.

Acceptance: in a Linux container, a framework secret is in neither `process.env` nor `/proc/self/environ` of the
process that loads the application; an ADR records the choice and its limit (`/proc/<parent>/environ` of a parent
running as the same user, which `makeProcessUndumpable` covers today).

## Touch points

- `packages/app/src/implement/environment.ts`, `packages/app/src/bun.ts` (`relaunchAsRuntime`, `serveContract`,
  `runContractJob`), `packages/app/src/undumpable.ts`
- `docs/reference/application-runtime.md`, `packages/app/CLAUDE.md`
