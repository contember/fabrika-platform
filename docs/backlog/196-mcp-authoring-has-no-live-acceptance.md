---
id: 196
title: MCP authoring has no live acceptance
blocked-by: []
---

# 196: MCP authoring has no live acceptance

**Summary.** The MCP authoring flow ([ADR-0049](../decisions/0049-author-applications-through-mcp-in-control.md)) is
was run against a light-tier Zerops test installation with real Claude and ChatGPT connectors and live stage deploys of
Notes (PR #51, "Verified live on a Zerops test installation"). The full sequence through a pull request and a production
deploy after the merge is not recorded, and four of the sprint's known limits are still open.

## Problem

From the run log of [the MCP authoring sprint](../archive/sprint-2026-10-07-mcp-authoring.md):

1. **No recorded end-to-end acceptance.** PR #51 records real connectors and live stage deploys on a test
   installation. Nothing records the whole WU7 sequence: a workspace commit's stage build, a pull request, and a
   production deploy after the merge, with a GitHub App that holds write permissions.
2. **An access token outlives its revocation** by up to 300 s.
3. **A workspace branch reset to an ancestor** concurrently can still be fast-forwarded: GitHub's REST API has no
   compare-and-swap on a ref.
4. **Two concurrent `authoring: true` puts** on different environments of one application can race past the
   one-authoring-environment rule.
5. **The App identity DTO states `contents: 'read'`** (`GitHubSourceConnectionAppDto`,
   `packages/control-contract/src/index.ts`), while the manifest asks for `contents: write` and `pull_requests: write`
   (`packages/github-app/src/manifest.ts`). Confirmed at HEAD on 2026-10-20; items 2 to 4 are as the run log of
   2026-10-07 states them.

## Approach / acceptance

Item 1: the sprint's WU7 manual run, recorded here: the stage URL serves the new commit, the reported SHA matches, the
pull request exists, a merge deploys production. Items 2 to 5: each fixed with a test, or recorded as accepted in
ADR-0049.

## Touch points

`packages/control/src/mcp/`, `packages/control/src/api/workspaces.ts`, `packages/control/src/github/workspace.ts`,
`packages/iam/src/oauth*.ts`, `packages/control-contract/src/index.ts`, `packages/provider-zerops/src/installation/`.

<!-- Origin: archive/sprint-2026-10-07-mcp-authoring.md, run log. -->
