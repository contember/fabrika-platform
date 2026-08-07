---
id: 25
title: Bootstrap the @fabrika npm packages and activate trusted publishing
blocked-by: []
---

# 25 — Bootstrap the `@fabrika` npm packages and activate trusted publishing

**Summary.** npm trusted publishing cannot create a package name for the first time, so the
twenty-two public packages need one authorized token-based publish through CI before every later
release can be tokenless. **Now on the critical path**: the repository has no tags, and
[62](./62-generate-the-operators-sidecar-install-repository.md)'s live acceptance needs the first
`v*` tag, which necessarily runs `release.yml`.

## Current boundary

All twenty-two public packages are absent from the registry — verified 2026-08-07 by anonymous
`GET https://registry.npmjs.org/@fabrika%2f<name>`: 404 for every one, and a registry search for
`scope:fabrika` returns `{"objects":[],"total":0}`. No tag has ever been pushed, so `release.yml` has
never run, and no GitHub Environment exists on the repository.

**The first-publish restriction is settled, not assumed.** npm's own `npm trust` prerequisites state
it outright — _"Package must exist: The package you're configuring must already exist on the npm
registry"_ ([npm-trust](https://docs.npmjs.com/cli/v11/commands/npm-trust/)) — and
[npm/cli#8544](https://github.com/npm/cli/issues/8544) is still open, with npm stating they
_"determined to not have 'first publish' available to limit scope in our MVP"_. Re-check that issue
before executing: if first-publish-via-OIDC has shipped, the entire bootstrap phase disappears.

Two constraints that did not exist when this item was written:

- **Classic npm tokens are gone.** npm permanently revoked them on 2025-12-09; they cannot
  authenticate or be recreated
  ([changelog](https://github.blog/changelog/2025-12-09-npm-classic-tokens-revoked-session-based-auth-and-cli-token-management-now-available/)).
  The bootstrap credential must be a **granular access token** with bypass-2FA, and write-scoped GATs
  expire in 90 days at most.
- **Bulk trust configuration is officially supported**, so this is not twenty-two web forms. `npm
  trust` (npm ≥ 11.15.0) documents a scripted loop with `--yes`, ~2s between calls, inside npm's
  five-minute "skip 2FA" window — _"you can configure approximately 80 packages within the 5-minute
  window."_

**`release:publish` cannot be reused for the bootstrap.** Its missing-package gate
(`scripts/release.ts:474-482`) throws before its first mutation, which is exactly what makes the
dry-run in `ci.yml:140` green today. The bootstrap must invoke `npm publish` on the packed tarballs
directly.

Two earlier claims here are now stale and are removed: the `provider-cloudflare` → private-`@fabrika/proxy`
regression was fixed by splitting out `@fabrika/proxy-core` (`2970715`), and the hosted-CI witness
exists — run `31115110029` on `main`, 2026-08-06, all four jobs green.

## Approach / acceptance

Ordered. Each step is marked with who must perform it.

1. **[human]** Confirm the `@fabrika` org exists with the publishing account as owner, and that
   account-level **2FA is enabled** — `npm trust` refuses without it. Neither is checkable
   anonymously.
2. **[decision]** Bootstrap at a prerelease (`v0.0.0-bootstrap.0`) or directly at `v0.0.1`. The
   prerelease routes to the `next` dist-tag (`scripts/release.ts:451`), leaves `latest` for the first
   OIDC release, and avoids depending on `npm pack` being byte-reproducible across two runners —
   which the direct route does, because the later same-tag run compares `dist.integrity` and **throws**
   on mismatch (`:420-440`).
3. **[human]** Create a granular access token — scope `@fabrika`, read+write, bypass-2FA on, shortest
   possible expiry — and a GitHub Environment holding it, gated by required reviewers. Never a repo
   secret, never exposed to pull requests or reusable workflows.
4. **[CI]** Dispatch a temporary `bootstrap-npm.yml`: pack and smoke through the existing scripts,
   then publish each tarball with `--access public --ignore-scripts --provenance`. **Never from a
   laptop** — the root `CLAUDE.md` forbids it, and this machine has a working `~/.npmrc` credential
   that would let it succeed silently.
5. **[scripted]** Upgrade npm to ≥ 11.15.0, then bind every package's trusted publisher to org
   `contember`, repo `fabrika-platform`, workflow `release.yml`, action `npm publish` — the allowed
   action is mandatory for configurations created after 2026-05-20. Prove it with `npm trust list`
   across all twenty-two.
6. **[scripted + human]** Delete the bootstrap workflow, revoke the token, delete the Environment.
7. **[CI]** Push `v0.0.1` and prove `release.yml` publishes the co-versioned set through OIDC with
   provenance. Re-run it and prove the integrity comparison makes the retry a verified no-op.
8. **[scripted]** Independent witness: a clean external project installs `@fabrika/cli`,
   `@fabrika/app`, and both provider packages from the registry.
9. **[human]** Restrict token publishing per package ("require 2FA and disallow tokens"); OIDC
   publishers keep working. Whether `npm access set mfa=publish` is exactly that setting is
   undocumented — verify on one package before applying it to twenty-two.

Acceptance: all twenty-two package pages exist, show provenance for a CI-produced release, and trust
only `release.yml`; a same-tag re-run is a verified no-op; and a tag pushed from this repository is
the only way a `@fabrika` package changes.

## Open questions

- Does `@fabrika` exist and is 2FA on? Not verifiable anonymously — npmjs.com returns 403 to
  unauthenticated requests whether or not an org exists.
- The exact `npm trust github` flag spellings, which are only visible from `npm trust github --help`
  on npm ≥ 11.15.0.
- Whether npm's `workflow_call` caveat touches `release.yml`. It should not — the `npm publish` runs
  in `release.yml`'s own `publish` job and `ci.yml` never publishes — but a wrong OIDC claim surfaces
  as `ENEEDAUTH` on the first real release, which is the second reason to bootstrap at a prerelease.
- Whether `.github/workflows/release.yml:40` should move off `npm@11.6.2` (2025-10-08). It clears
  trusted publishing's floor but predates both the December 2025 auth overhaul and the 2026-05-20
  allowed-actions change.

## Touch points

- npm organization and package settings
- a temporary protected GitHub bootstrap workflow
- `.github/workflows/release.yml`
- [`../reference/release-process.md`](../reference/release-process.md)

<!-- Rescoped from the pre-merge CI migration item by the Automated release readiness sprint;
     re-verified against npm's current docs and the live registry on 2026-08-07. -->
