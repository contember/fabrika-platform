---
id: 23
title: The CLI platform template still checks out two repositories
blocked-by: []
---

# 23 — The CLI platform template still checks out two repositories

`packages/cli/src/templates/platform.yml` checks out `contember/vozka` **and**
`contember/propustka` as two separate repos, pinned by `vozka.ref` / `propustka.ref`.
After the merge that is structurally wrong — there is one repository.

The agent that did the merge applied the in-repo renames (paths, config filenames,
the documented command) but deliberately stopped there, on the grounds that
half-renaming a two-repo checkout produces a _new_ kind of broken rather than a
fixed one. That judgement was right; the rewrite is still owed.

`scaffold.ts` shares the problem: its scaffold contract still emits
`<org>/vozka-platform` and a `vozka.ref` file.

## Acceptance

`fabrika init` produces a working pipeline against the single merged repository, and
nothing in the templates references a repo or ref file that no longer exists.
