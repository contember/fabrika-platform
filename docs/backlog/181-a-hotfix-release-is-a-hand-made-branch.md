---
id: 181
title: A hotfix release is a hand-made branch off the last tag
blocked-by: []
---

# 181 — A hotfix release is a hand-made branch off the last tag

**Summary.** Three production hotfixes (v0.4.3–v0.4.5) were cut by hand from the last release tag. One release
command should do the branch, the cherry-picks, the bump, the commit and the tag. Small effort.

## Problem

`release:bump` sets the version in the source of the current checkout. A hotfix needs a different source: the last
release tag plus a few commits from `main`. Each hotfix was therefore a manual sequence: create `hotfix/vX` from the
tag, cherry-pick, `release:bump`, commit `chore: release vX`, tag, push the tag. The sequence ran in a shared
checkout, so it switched the branch under other agents working there, and a slip in it reaches a published tag.

## Decision

`bun run release:hotfix --from=<release tag> --tag=<next tag> <commit>...` runs the sequence in a temporary git
worktree of the same repository. The caller's checkout, branch and uncommitted files stay as they are. The bump and
the validation are those of the release being patched: its own `scripts/release.ts`, run inside the worktree. The
command pushes nothing unless `--push` is given; otherwise it prints the exact push command.

## Scope

- In: branch `hotfix/<tag>` from `--from`, `git cherry-pick -x` of each commit, `release:bump`, the release commit,
  `release:validate`, an annotated tag, worktree removal, an optional push.
- Out: resolving a cherry-pick conflict (the command stops and cleans up; back-port the commit by hand first), moving
  `main`'s source version past the hotfix.

## Acceptance criteria

- A temporary-repository test proves: the branch and the annotated tag hold the cherry-picks and the release commit;
  the caller's HEAD, branch and uncommitted file are unchanged; no worktree remains.
- A conflicting commit, a failed validation or an untracked file left by the bump leaves no branch, tag or worktree.
- An existing tag or branch, an unknown base and a tag that does not move past the base are refused before anything
  is created.
- `docs/reference/release-process.md` describes the command.

## Touch points

`scripts/release.ts`, `scripts/__tests__/`, `package.json`, `docs/reference/release-process.md`.
