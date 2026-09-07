---
id: lib-publish
kind: pattern
title: Lib publish — tag → npm publish with OIDC trusted publishing + provenance
slot: null
provides: [npm-publish, oidc-trusted-publish, provenance]
requires: []
recommends: [bun, monorepo]
conflicts: []
status: stable
sources:
  - where: "oblaka / lopata / buzola / pletivo — .github/workflows/release.yml (tag-triggered publish)"
    read: "The `on: push: tags: ['v*']` trigger, `permissions: id-token: write`, and `npm publish --provenance --access public` with no NPM_TOKEN."
  - where: "opice — .github/workflows/release.yml (monorepo: version rewrite + per-package publish); roj — .github/workflows/publish.yml + scripts/npm-publish/"
    read: "Multi-package coordination: rewrite versions + resolve workspace:* refs at publish time."
---

# Lib publish (npm, OIDC trusted publishing)

## What it is

A library publishes on a **git tag `v*`** via GitHub Actions using **OIDC trusted
publishing** — `permissions: id-token: write`, then **`npm publish --provenance
--access public`** with **no long-lived `NPM_TOKEN`** (GitHub's OIDC token is
exchanged by npm for short-lived registry auth, and `--provenance` attaches SLSA
build attestation). Requires **npm ≥ 11.5.1** (some workflows `npm i -g npm@latest`
first). Version bumps are explicit (`package.json` → tag), no changeset tooling.

## When & why to use

- Publishing any `@scope/*` package (our libs: oblaka, lopata, opice, buzola, pletivo, @roj-ai/*) — secure, tokenless, provenance-stamped.

## When NOT to use

- Private/unpublished packages, or apps (apps **deploy**, see `app-deploy`).

## Gotchas

- **`id-token: write` is mandatory** — without it the OIDC exchange fails; there's no token fallback by design.
- **npm ≥ 11.5.1** for OIDC trusted publishing; pin Node/npm in the runner.
- **Trusted publishing must be configured on the npm package** (the repo/workflow is registered as a trusted publisher) before the first run.
- **Monorepo multi-package**: rewrite each `package.json` version from the tag **and resolve `workspace:*`** refs to the concrete version before publishing each package.

## Relationships — why

- A CI pattern (no runtime tech deps). **recommends `bun`** (build/pack) and **`monorepo`** (multi-package publish coordination). The lib-side counterpart of `app-deploy`.
