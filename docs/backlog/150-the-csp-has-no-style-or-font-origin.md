---
id: 150
title: The CSP has no style or font origin
blocked-by: []
---

# 150 — The CSP has no style or font origin

**Summary.** A contract's `csp` section extends `connect-src`, `img-src`, `frame-ancestors`, `script-src` and
`frame-src`. `style-src` and `font-src` are fixed, so a page cannot load a web font from a font service. Effort: S.

## Problem

- The proxy's policy is `style-src 'self' 'unsafe-inline'` and `font-src 'self' data:`
  (`packages/proxy-core/src/headers.ts:97`, `:99`). `CSP_FIELDS` (`packages/app/src/contract/build.ts:111`) lists no
  style or font field.
- An application built on the paved road wanted a typeface from a hosted font service (a stylesheet origin and a font
  origin). It fell back to a system font stack. Self-hosting the font files under the SPA's `dir` would also work.

## Approach / acceptance

- Decide: add `styleSrc` and `fontSrc` to the contract's `csp` (shown in the approval diff like the others), or state
  in the skill that fonts are self-hosted.
- Witness: a contract with `fontSrc` and `styleSrc` origins produces those directives, and the approval diff shows them.

## Touch points

`packages/proxy-core/src/headers.ts`, `packages/app/src/contract/{build.ts,declaration.ts,artifact-schema.ts}`,
`packages/control/src/approval/diff.ts`, `packages/app/skill/references/app-setup.md`.
