---
id: 148
title: The checker reads a local binding as a global
blocked-by: []
---

# 148 — The checker reads a local binding as a global

**Summary.** `fabrika-check` matches refused globals and focused-test aliases by name. A local `const window = …` in a
server module and a local `fit(…)` helper in a test are refused as the browser global and Bun's focused test. Effort: S.

## Problem

- `checkIdentifier` reports `forbidden-global window is not used in a server module` for any value reference named
  like an entry of `SERVER_REFUSED_GLOBALS` (`packages/check/src/rules/runtime.ts:33`, `:396`), without resolving the
  binding.
- `checkTestNode` reports `skipped-test fit leaves tests out of the run` for any call rooted at a name in
  `NOT_RUN_ALIASES` (`packages/check/src/rules/tests.ts:9`, `:70`), also `expect(fit(x))` of a local helper.
- An application built on the paved road met both (seven refusals for a variable named `window`) and renamed the
  bindings.

## Approach / acceptance

- Resolve the identifier to its declaration in the module: a name bound by a local declaration, a parameter or an
  import is not the global. Or keep the name rule and say in the finding that renaming the binding satisfies it.
- Witness: rules tests where a local `window` and a local `fit` pass and the globals still fail.

## Touch points

`packages/check/src/rules/{runtime.ts,tests.ts}`, `packages/check/src/ast.ts`, `packages/check/src/__tests__/rules.test.ts`.
