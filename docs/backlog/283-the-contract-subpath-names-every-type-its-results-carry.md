---
id: 283
title: The contract subpath names every type its results carry
blocked-by: []
---

# 283 — The contract subpath names every type its results carry

**Summary.** An application with `declaration` on cannot export the result of some `@fabrika/app/contract` functions:
TypeScript 7.1 reports TS2883 because the type comes from `@fabrika/auth-core`, which the application does not depend
on. Small.

## Problem

`@fabrika/app/contract` re-exports `ContractArtifact`, so `export const c = compileContract(…)` declares. Its other
public signatures still reference `@fabrika/auth-core` types that it does not export, for example `AppSchema`
(`schemaFromContract`) and `ExportDescription` (`exportDescription`); `export const s = schemaFromContract(c)` fails
under 7.1 (and tsrs) with `declaration: true`, also under `noEmit`. The emitted declarations of the subpath reference
about twenty such types (`SchemaShape`, `TablePolicyArtifact`, `OutputShape`, `RpcCaller`, `WebhookScheme`, …).

## Approach / acceptance

Decide which of them are framework API, and re-export those type-only from `@fabrika/app/contract`. Add a probe the
type check compiles, with `declaration` on, that exports the result of every public function of the subpath, so a new
signature that leaks an unnamed type fails `bun run typecheck`.

## Touch points

`packages/app/src/contract/index.ts`, a probe under `packages/app/src/__tests__/`, the 0.9 section of
`docs/reference/framework-migrations.md` if the export list changes.

<!-- Origin: review of the tsrs check gate (PR #149). -->
