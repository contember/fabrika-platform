---
id: 239
title: A changed SQL statement shows no closer-review line
blocked-by: []
---

# 239 — A changed SQL statement shows no closer-review line

**Summary.** A site whose `sql:` declaration is unchanged can change its statements freely, and the approval diff shows
nothing; since `ctx.sql` no longer checks where a scope fragment stands, the approver is the only reader of that text.

## Problem

The approval diff compares a site's declared reach only (`packages/control/src/approval/diff.ts:657`,
`modeChange` at `:729`): a new `sql` declaration or `read` → `write` is a closer-review line, and nothing else about
raw SQL is. The snapshot holds the contract artifact and the migrations' database code, not the handler modules, so a
commit that rewrites a statement of an already-declared site (drops a fragment, moves it under an `OR`, writes another
table) publishes on a protected environment without approval. ADR-0012 makes the fragment's placement and a statement's
reach within the application's own tables a review signal; this is the gap in that signal.

## Approach / acceptance

Put each declaring site's statement texts into the access snapshot, keyed by site, and show a changed text as a
closer-review line. Open: how Control reads them without evaluating handler code (the shell slice drops handlers),
whether a site's statements are its `ctx.sql` / `tx.sql` tagged templates read statically, and what a statement built in
a helper module shows. Acceptance: a test that publishes a site, edits only its statement text, and sees the run park on
a protected environment.

## Touch points

`packages/control/src/approval/diff.ts`, `packages/control/src/approval/` snapshot reading, `packages/check` (a static
reader of a site's statements), `docs/decisions/0050-approved-access.md`.
