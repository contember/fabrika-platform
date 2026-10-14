---
id: 151
title: The SPA and the server cannot share a pure function
blocked-by: []
---

# 151 — The SPA and the server cannot share a pure function

**Summary.** The SPA may import `@fabrika/app/client`, the contract, `src/schemas.ts` and `web/`, and `src/schemas.ts`
holds literal consts only. A pure rule both sides need (a template fill, a greeting form) has no home. Effort: S.

## Problem

- `spa-server-import` admits only those modules (`packages/check/src/rules/structure.ts:132`), and the skill says
  `src/schemas.ts` holds "literal consts only" (`packages/app/skill/references/endpoint.md:26`).
- An application built on the paved road previews an e-mail on a staff screen. The server fills the template; the
  screen needs the same fill. It moved one function into an answer field computed by the server, and copied the other
  into `web/` (display only; the server's copy decides the e-mail). Two copies drift.

## Approach / acceptance

- Decide a place for shared pure code, for example `src/shared/` that imports nothing but `zod/v4` and itself, that
  the SPA and every slice may import, and that the checker keeps free of server modules and globals.
- Witness: the checker passes a shared function used by a slice and by `web/`, and refuses a shared module that
  imports a slice or `@fabrika/db`.

## Touch points

`packages/check/src/{layout.ts,rules/structure.ts}`, `packages/app/skill/SKILL.md`,
`packages/app/skill/references/{endpoint.md,app-setup.md}`.
