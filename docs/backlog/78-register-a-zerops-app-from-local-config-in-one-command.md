---
id: 78
title: Register a Zerops app from local config in one command
blocked-by: []
---

# 78 — Register a Zerops app from local config in one command

**Summary.** Compose the existing local manifest build and Control registration into one CLI command,
without teaching Control to execute application code. Effort S–M.

## Problem

The secure pieces already exist, but the operator must compose them:

1. `fabrika app build --env=<env>` loads the repository's TypeScript config and writes
   `fabrika.manifest.json` locally.
2. `fabrika control register --manifest=<path> ...` reads that artifact and sends it through the
   existing Control RPC.

The dashboard offers the same registration by asking the operator to paste the JSON. This preserves
the right trust boundary — application code runs on the operator's machine, not in the credential-owning
Control plane — but it makes a normal registration a two-command or copy-and-paste procedure and lets
an old manifest be selected accidentally.

A new manifest-upload endpoint is not needed. `control register` and `apps environments put` already
carry the complete provider artifact over the existing typed RPC.

## Approach / acceptance

Add one local Zerops app command that loads the config, reads the repository-root `zerops.yaml`,
compiles the manifest in memory and immediately performs the existing create-only Control registration.
Reuse the current provider compiler and Control request path; do not add a server-side builder, execute
repository code in Control, or persist an intermediate file merely to pass data between commands.

Acceptance:

- from a repository root, one command registers a new Zerops app and environment using the same inputs
  and three-state GitHub installation selection as `control register`;
- the request produced from an in-memory build is byte-for-byte equivalent to registering the same
  manifest from disk;
- Control URL and machine credential remain environment-only where they are environment-only today;
- compilation or registration failure leaves no partially written local artifact and reports which
  phase failed; and
- focused CLI tests cover public, resolved private and explicit-installation registration without a
  new Control endpoint.

Updating an already registered environment remains the explicit `apps environments put` operation
unless the command design can distinguish create from replace without hiding their different
semantics.

## Touch points

`packages/cli/src/{index,control}.ts`; `packages/provider-zerops/src/cli.ts`; their focused tests and
CLI usage documentation.

<!-- Origin: archived sprint-2026-08-11-fabrika-deploys-an-app-on-zerops open manifest decision. -->
