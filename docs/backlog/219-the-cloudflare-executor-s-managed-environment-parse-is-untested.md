---
id: 219
title: The Cloudflare executor's parse of its managed environment is untested
blocked-by: []
---

# 219 — The Cloudflare executor's parse of its managed environment is untested

**Summary.** The executor parses the managed values its job carries, but no test shows that a bad one stops the deploy
before any `wrangler` call. Low: Control parses the same values first, so only a hand-run executor meets it.

## Problem

`deployCloudflareConfig` (`packages/provider-cloudflare/src/command.ts`) reads each `--managed-var` from the environment
and parses the set with `parseManagedEnvironment` (`@fabrika/auth-core`). The parser is tested on its own
(`packages/auth-core/src/__tests__/managed-environment.test.ts`), and Control's parse is witnessed in
`packages/control/src/__tests__/connector-edges.test.ts`. Nothing drives the executor with a value Control would not
produce (`FABRIKA_JOB_NIGHTLY_KEY=plain`, a `FABRIKA_CONTRACT_DIGEST`, an `http` connector origin).

## Approach / acceptance

A test of `deployCloudflareConfig` with one such `--managed-var`: it rejects naming the variable and not its value, and
the collaborators record no command.

## Touch points

`packages/provider-cloudflare/src/__tests__/` (beside the existing CLI tests).

<!-- Origin: the WU2 review in docs/sprints/sprint-2026-10-23-provider-neutral-core.md. -->
