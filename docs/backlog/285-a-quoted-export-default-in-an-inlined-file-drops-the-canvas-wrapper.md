---
id: 285
title: A quoted `export default` in an inlined file drops the canvas wrapper
blocked-by: []
---

# 285 — A quoted `export default` in an inlined file drops the canvas wrapper

**Summary.** A canvas whose `<Markdown file>` names a file containing `"export default"` compiles without its `Plan`
wrapper, so the view has no default export. Small fix in the canvas compiler.

## Problem

`packages/canvas-kernel/src/engine/compiler.ts` decides whether a canvas already has a default export by removing string
literals with regular expressions and testing for `export default`. The double-quoted pattern `"[^"]*"` does not skip an
escaped `\"`. An inlined file arrives as a `JSON.stringify` string, so a Markdown body with a quoted `"export default"`
leaves that text outside a matched string: `compileJsx` returns `ok: true` without wrapping the canvas. The builder's
generated views inline repository files (`flows review`, `design review`), so a flow or `design.md` can trigger it.

## Approach / acceptance

Detect the default export on the source before files are inlined, or match string literals with their escapes. A test
compiles a canvas whose inlined file contains `"export default"` (quoted) and finds the `Plan` wrapper.

## Touch points

`packages/canvas-kernel/src/engine/compiler.ts` and its tests.

<!-- Origin: the independent review of the builder's design-checkpoint contrast check. -->
