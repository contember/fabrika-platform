---
id: 272
title: Authoring workspaces on kompjutr
blocked-by: []
---

# 272 — Authoring workspaces on kompjutr

**Summary.** Each MCP authoring workspace keeps a kompjutr working tree (Git and files over SQLite), so reads, regex
search and multi-file edits run locally instead of one GitHub request per file. A bold bet; large.

## Problem

MCP authoring reads the repository through the GitHub API ([`mcp-authoring.md`](../reference/mcp-authoring.md)):
`search_files` reads at most 100 files, matches only a literal text, and costs one GitHub request per file; every
commit is a GitHub write. A hosted agent is slow and sees little of the repository.

## Approach / acceptance

A workspace gets a kompjutr tree: one clone, then `read_files`, regex search and edits run against SQLite. Control pushes
to the `fabrika/<id>` branch on each commit (or batches) and GitHub stays the source of truth for pull requests and
deploys. Control already owns workspace heads, expected-head checks and the GitHub App token
(`packages/control/src/workspace-source-port.ts`, `packages/control/src/github/`). The dev sandbox launcher could pull
from the tree instead of a GitHub compare.

Risks: kompjutr's Durable Object composition fits Cloudflare; on Zerops the local package uses `node:sqlite` and
declares Node 24, while fabrika runs on Bun; whether it runs under Bun is unverified. kompjutr has no production users
yet. A second copy of the tree adds a consistency failure mode (the push must name the expected remote head). Decide
between this and [271](271-fast-dev-sandboxes-on-cloudflare.md) after measuring where hosted agents lose time.

Acceptance: a regex search over a 2,000-file repository answers in one call without a GitHub request per file, and a
commit made through the tree lands on the workspace branch with the expected-head check intact.

## Touch points

- `packages/control/src/workspace-source-port.ts`, `packages/control/src/github/`, `packages/control/src/mcp/`
- `packages/control/src/dev/` (launcher source)

<!-- Origin: feature ideas review, 2026-11-02. -->
