---
id: 109
title: Application code can boot a second runtime with its own keys
blocked-by: []
---

# 109 — Application code can boot a second runtime with its own keys

**Summary.** `boot` is a public export of `@fabrika/app/implement`, so an application module can boot a second
runtime that trusts IAM keys of its own and receive authentic capabilities from it, and the checker reports nothing.
A gap in the in-process hardening of ADR-0012 §7, not a hard boundary. Small effort.

## Problem

After the capability mint moved into `boot.ts` (claimed once at load, handed to `ContractRuntime` and `bindJobs` as
a parameter), no import reaches a mint that `requestCapabilities` accepts. `boot` itself still mints for whatever it
was booted with:

- `boot(app, options)` takes `options.iam` (the JWKS it verifies tokens with) and `options.environment` (the framework
  variables, the proxy secret among them) from its caller. `captureEnvironment` and `boot` are both exports of
  `@fabrika/app/implement` (`packages/app/src/implement/index.ts`).
- An application module can boot a second `implement(…)` with a key pair it generated, sign a token with any grant,
  and call the second runtime's `fetch` in-process. Its handler receives a framework-minted `Ref`, which the
  application's real stores accept: `requestCapabilities` checks only the issuer and the running request. The real
  layer refuses a second bind, so the second implementation declares a `ContractDatabase` of its own, and its handler
  calls the real stores.
- `testKit` boots the same way on purpose; it refuses a production process, `boot` does not.

Not reproduced end to end; the route follows from `boot.ts` and `dispatch.ts` as they are.

## Approach / acceptance

- Decide where `boot` may be called: in a process `markProductionProcess` marked, `boot` runs once and a second call
  throws (the generated entrypoint boots once; the test kits never run there). `fabrika job run` must mark its
  process too, or the job process keeps the gap (it does not mark today, so the test kits load there as well).
- The checker refuses an application import of `boot` from `@fabrika/app/implement` outside the generated entrypoint,
  as it refuses `@fabrika/db/framework`.
- Witness: a marked process refuses a second `boot`; a checker fixture for the import.

## Touch points

`packages/app/src/implement/boot.ts`, `packages/cli/src/job.ts`, `packages/check/src/rules/modules.ts`,
`packages/app/CLAUDE.md`, `packages/check/CLAUDE.md`, ADR-0012 §7.

<!-- Origin: the fix of backlog 105 and 106 (the in-process hardening). -->
