---
id: 131
title: An application outside the monorepo cannot use locally packed packages
blocked-by: []
---

# 131 — An application outside the monorepo cannot use locally packed packages

**Summary.** To try unreleased packages in an application outside the repository, you pack them and install the
tarballs. No supported path does that. The tarballs do not install without hand-written overrides, the checker
refuses the result, the packed skill pins a version that npm does not have, and a pack needs a release tag.
Effort: M.

## Problem

- **The install.** `release:pack` stages each public package with its `@fabrika/*` dependencies rewritten to
  `^<version>` (`stagedManifest`, `scripts/release.ts:283`–`:295`). A tarball installed by `file:` therefore resolves
  its own `@fabrika/*` dependencies from npm. The private dogfood needed an `overrides` entry for every public package
  (23) to keep the whole graph local. `release:smoke` avoids this by listing every package as a direct `file:`
  dependency (`scripts/release.ts:578`). The skill's setup (`packages/app/skill/references/app-setup.md:40`–`:42`)
  covers the registry and the monorepo workspace only.
- **The checker.** `package-replacement` (`packages/check/src/rules/packages.ts`; ADR-0043) refuses `overrides`
  (`:75`–`:79`), a specifier that is not a registry range (`:80`–`:88`) and a lockfile entry without the registry's
  `sha512` (`:92`–`:110`). The dogfood got 28 refusals, and none of its 16 checker runs exited 0. The agent read the
  other findings past them.
- **The pinned version.** `release:pack` rewrites the skill's example pins to the packed version
  (`stagedAppSkill`, `scripts/release.ts:313`–`:314`; `rewriteExamplePins`, `:802`). A local pack is a prerelease
  (`^0.3.2-dogfood.<sha>`) that npm does not have, so an agent that copies the example's `package.json` breaks its
  install.
- **The version.** `resolveTag` needs `--tag`, `RELEASE_TAG` or an exact `v*` tag at HEAD
  (`scripts/release.ts:238`–`:249`). The source packages are at `0.0.4` while npm has `0.3.1`, so a local pack's
  version is whatever tag the operator chose.

## Approach / acceptance

- `release:pack --local` derives `<latest npm version>-local.<short sha>` without a tag. It also writes, beside the
  tarballs and `release-manifest.json`, each tarball's `sha512` and the `dependencies` + `overrides` block that installs
  the whole set.
- The checker accepts `file:` specifiers and overrides only when it is given that manifest explicitly
  (`fabrika-check --packed <release-manifest.json>`), and only for tarballs whose `sha512` matches it. The platform
  build never passes the manifest, so a deployed application still installs from the registry (ADR-0043 is
  unchanged for a deploy).
- A local pack leaves the skill's example pins at the last published range, and `app-setup.md` says how to install a
  local pack.
- Witness: a `release.test.ts` case that packs locally, installs the set into a scratch application from the written
  block, and passes `fabrika-check --packed`. The same application without `--packed` gets the refusals.

## Touch points

`scripts/release.ts`, `scripts/__tests__/`, `packages/check/src/{cli.ts,rules/packages.ts}`,
`packages/app/skill/references/app-setup.md`.

<!-- Origin: the paved-road sprint, WU21 (the private dogfood's setup). -->
