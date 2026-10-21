---
id: 197
title: local:compat does not deploy Notes at v0.7.0
blocked-by: []
---

# 197 — local:compat does not deploy Notes at v0.7.0

**Summary.** 0.8 serves 0.7 applications, and Control's `framework-compat.test.ts` proves it from the CRM at v0.7.0,
but `local:compat` still deploys only Notes at v0.6.0, v0.5.5 and v0.4.8 and upgrades each to the workspace example.

## Problem

`proveRelease` in `packages/local-stack/src/compat.ts` proves a release through its file collection
(`/api/files.attachments.*`), and `proveUpgrade` through the migration that adopts it. Notes at v0.7.0 has no file
collection: its attachments are procedures over `note_attachments` already, so neither proof applies. Recording the
release (`bun run fixtures:release v0.7.0`) and listing it in `LOCAL_SOURCE_RELEASE_TAGS` alone would fail the suite.

## Approach / acceptance

Record Notes at v0.7.0, register it as `release070` as `release060` is, and give the suite a proof for a release
without a file collection: its notes and attachments served, an attachment uploaded and downloaded byte for byte, and
the upgrade to the workspace example keeping them. `bun run local:compat` passes for v0.7.0 and every older release.

## Touch points

`packages/local-stack/src/compat.ts`, `local-source-contract.ts`, `local-source-fixtures/{generate,pin,fixture.test}.ts`,
`fixtures/source/`, `packages/local-stack/CLAUDE.md`, `docs/reference/local-development.md`.

<!-- Origin: the 0.8.0 release, which added the 0.7 reader to the window. -->
