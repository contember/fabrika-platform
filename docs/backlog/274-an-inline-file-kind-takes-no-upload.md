---
id: 274
title: An inline file kind takes no upload
blocked-by: []
---

# 274 — An inline file kind takes no upload

**Summary.** The contract build refuses a procedure whose file input is of a kind declared `inline: true`, so only the
application's own code fills an inline kind. S.

## Problem

A file kind declared `inline: true` serves its XML types with `Content-Disposition: inline` (ADR-0022 rule 2,
ADR-0061). The sandbox CSP stops script, forms, loads, meta refresh and stylesheets, but XML whose elements are in the
XHTML or SVG namespace still renders as a page, with live links, on the application's origin. The upload sniff accepts
any UTF-8 text that starts with `<`, so whoever uploads into an inline kind can show such a page. Today only the docs
and the agent skill say an inline kind holds what the application writes; nothing enforces it. A namespace sniff would
not hold: a namespace can be declared on any element, through any prefix.

## Approach / acceptance

- `buildArtifact` refuses a procedure input that carries a file (`containsFile`, `packages/app/src/contract/build.ts`)
  of an inline kind, naming the kind and the procedure, and saying to write the file with `ctx.files.put` instead.
- The static reader in `@fabrika/check` reports the same, and `differential.test.ts` keeps both in agreement.
- `contractArtifactSchema` refuses such an artifact, so a hand-built artifact cannot pass either.
- Tests: the refusal per form (top-level file input, a file in an object and in an array), and an inline kind filled by
  `ctx.files.put` still builds.
- ADR-0022 rule 2 and ADR-0061 state the rule instead of the advice.

## Touch points

`packages/app/src/contract/build.ts`, `packages/app/src/contract/artifact-schema.ts`, `packages/check/src/reader/`,
`packages/app/skill/references/files.md`, ADR-0022, ADR-0061.
