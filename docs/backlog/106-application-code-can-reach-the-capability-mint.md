---
id: 106
title: Application code can reach the capability mint
blocked-by: []
---

# 106 — Application code can reach the capability mint

**Summary.** `mintRef` and `mintWithin` are not exported from `@fabrika/app/implement`, but an application module can
load their module by URL and mint an authentic capability for any dimension, action and chain in the current request,
and the checker reports nothing. A defect against the rule that only the framework mints capabilities. Small to medium
effort.

## Problem

`packages/app/CLAUDE.md` says `Ref` and `Within` "need a module-private token to construct; never export that token
or the mint functions from `implement/index.ts`", and ADR-0012 §2 says a handler receives authorized capabilities,
checked at runtime. Today:

- `packages/app/src/implement/capability.ts:276–298` exports `mintRef`, `mintWithin` and `activeRequest` as module
  exports. `index.ts` does not re-export them, but the package ships `src/` (`packages/app/package.json` `files`), so
  the module is on disk next to the subpath's entry.
- `new URL('./capability.ts', import.meta.resolve('@fabrika/app/implement'))` followed by `import(url.href)` loads the
  same module instance the dispatcher uses. Inside a request, `mintRef(activeRequest(), 'note', 'notes.delete', …)`
  returns a `Ref` that `requestCapabilities.resolve` accepts, because it checks only that the framework minted it for
  this request.
- `packages/check/src/references.ts:63–66` ignores an `import()` whose specifier is not a static string, and no rule
  looks at `import.meta.resolve`, so the module above produces zero findings.

Reproduced on `main` (4f02fcd8): the checker run over the clean fixture plus that module reports nothing, and in a
synthetic `RequestFrame` the forged grant resolves as `ref note notes.delete`. No database was touched; `@fabrika/db`
would then scope rows by the forged chain.

## Approach / acceptance

- Make the mint unreachable by any import: `capability.ts` exports no mint function. The framework obtains it once,
  through a registration the dispatcher performs at load (before the generated entrypoint imports the application),
  the pattern `registry.ts` uses for `bindScopedDatabase`; a second registration throws.
- The checker refuses an `import()` or `require()` with a non-static specifier and any `import.meta.resolve`, as
  `unchecked-import`: the checker cannot say what such a load reaches.
- Witness: a test that loading `capability.ts` by URL exposes no mint and that a second registration throws; checker
  fixtures for a computed `import()` and for `import.meta.resolve`; `capability-chain.test.ts` and the job runner
  suites stay green.

## Touch points

`packages/app/src/implement/capability.ts`, `packages/app/src/implement/dispatch.ts` and the job runner (their mint
calls), `packages/check/src/references.ts`, `packages/check/src/rules/`, `packages/check/CLAUDE.md`,
`packages/app/CLAUDE.md`.

<!-- Origin: the security critique of docs/ideas/agent-friendly-app-framework.md. -->
