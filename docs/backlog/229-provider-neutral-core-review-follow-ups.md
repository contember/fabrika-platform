---
id: 229
title: Provider-neutral core review follow-ups
blocked-by: []
---

# 229 — Provider-neutral core review follow-ups

**Summary.** The gaps the merge reviews of the provider-neutral core (WU1–WU9) left open. One P2 leaves a live
Cloudflare version without its IAM schema until the next deploy; the rest are small.

## Problem

**Control's IAM write (WU1, `packages/control/src/run-lifecycle.ts`, `iam-schema.ts`).**

1. **P2: a late cancel skips the IAM write on Cloudflare.** A cancel that lands after the runner finished
   `wrangler deploy` but before Control writes the schema throws `cancel_requested` at the boundary, and
   `settleRunCancellation` runs. Cloudflare's `cancel` (`packages/provider-cloudflare/src/control.ts`) settles with no
   outcome, so the run is marked failed and the live version serves without its IAM schema until the next deploy.
   On main before WU1 the write ran inside `provider.deploy`, before that boundary. The proxy still enforces the new
   endpoint table.
2. `isIamUnavailable` treats every error that is not a `ReconcileSchemaError` as IAM being unavailable, a
   misconfiguration or a code bug included, so reconcile and cancel keep the run `running` and the environment blocked.
3. Every maintenance pass during an IAM outage appends another `reconcile-schema failed` line to the run log.
4. Reconcile and cancel write the environment's current approved schema, not necessarily the one the run deployed, when
   a newer publication happened in between (older than WU1).

**Version skew (WU1).**

5. The Cloudflare executor now refuses a connector URL that is not a canonical origin
   (`packages/provider-cloudflare/src/command.ts`), while an older Control does not lower-case the domain. An
   application importing a connector stored with a mixed-case domain fails to deploy until Control is upgraded.

**Build recipe (WU5, `packages/app/src/build-recipe.ts`, `packages/provider-zerops/src/execution.ts`).**

6. `sourceRoot` and `runtimeRoot` go into commands unquoted and unchecked, although the recipe refuses values a shell
   would split. Both are Zerops constants today.
7. `recipeOf` builds and validates the recipe three or four times per render, so `sizeDatabase` now also fails on a bad
   checker release.

**The Bun host and the provider CLI (WU7–WU8).**

8. MCP refuses only a missing `authoring`, not an empty `protectedFiles` or a name with `/`, which can never match the
   basename comparison in `packages/control/src/api/workspaces.ts` (`packages/control/src/bun/mcp.ts`). Only Zerops
   declares it today, with two valid names.
9. An unscoped `--provider=<name>` of a platform command now means `@fabrika/provider-<name>/installation`
   (`packages/cli/src/index.ts`), so a third-party unscoped package no longer resolves.
10. `fabrika namespace --help` without `--provider` no longer lists the Zerops options.

**Package surface (WU4, WU9).**

11. `@fabrika/provider-contract`'s conformance subpath imports `bun:test`; its CLAUDE.md does not say it is Bun-only.
12. `@fabrika/provider-zerops/installation` no longer exports `platformServiceTableDigest`,
    `resolvePlatformProxyManifest`, `McpClient`, `parseMcpClientsJson`, the `PlatformProxy*` types and `IamOAuthConfig`;
    they come from `@fabrika/installation-init`. Only code outside the repository that imports the tarball is affected.

## Approach / acceptance

- 1: once the provider reports `succeeded`, write the schema before the cancellation check, or let Cloudflare's
  `cancel` report the runner's known outcome. A test cancels between a succeeded deploy and the write.
- 2–3: classify only network and abort errors as unavailable; log a failure once per streak.
- 5: lower-case the domain in the executor's parse, or state the skew in the release notes.
- 6: check both roots against a literal absolute-path pattern. 7: build the recipe once per render.
- 8: refuse an empty `protectedFiles` and a name with `/`, in `controlMcpRoute` or a `provider-contract` validator.
- 9, 10, 12: release notes, or accept only scoped and path specifiers for third-party providers.
- 11: state it in the package's CLAUDE.md.

## Touch points

`packages/control`, `packages/provider-cloudflare`, `packages/provider-zerops`, `packages/app/src/build-recipe.ts`,
`packages/cli`, `packages/provider-contract`.

<!-- Origin: the merge reviews of PRs #50, #54, #57 and #58; ../sprints/sprint-2026-10-23-provider-neutral-core.md. -->
