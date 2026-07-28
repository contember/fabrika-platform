---
id: 24
title: The runner Docker image cannot resolve the renamed auth packages
blocked-by: []
---

# 24 — The runner Docker image cannot resolve the renamed auth packages

`packages/runner/docker/package.json` builds a slim workspace that `bun install`s
its auth dependencies **from the npm registry**. Before the merge those were
published `@propustka/*` packages. They are now `@fabrika/auth` and
`@fabrika/auth-core`, which are workspace siblings and do not exist on npm.

The version ranges were updated for consistency during the merge, which means the
image build fails at install rather than resolving something wrong — loud, at least.

## Fix

The Dockerfile must `COPY packages/auth packages/auth-core` (the build context is
already the repo root) and add them to the image's workspace list, the same way the
engine is already vendored in.

## Acceptance

`bun run docker:build` in `packages/runner` succeeds, and the baked `fabrika` CLI
can run a Cloudflare deploy end to end.
