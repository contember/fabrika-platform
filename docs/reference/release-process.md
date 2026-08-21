# Verification and release process

This repository verifies every pull request and `main` push. Version tags reuse the same verification workflow before publishing one co-versioned set of public packages.

## Repository CI

`.github/workflows/ci.yml` has four independent gates:

1. **Quality** installs the frozen Bun lockfile, checks formatting and lint, typechecks every workspace package and the release tool, and verifies generated Zerops artifacts.
2. **Backend tests** run the complete Bun suite with PostgreSQL 17 and an initialized MinIO bucket. `FABRIKA_TEST_POSTGRES_URL` and every required `FABRIKA_TEST_S3_*` value are present, so opt-in integration suites cannot become skips.
3. **Deployable builds** build the unified dashboard and the Bun proxy executable. The proxy build uses a committed empty manifest, proving the binary and a fail-closed generated Caddy configuration without relying on local deployment state.
4. **Release artifacts** stage, pack, install, import, and dry-run-publish every public package at a disposable prerelease version.

The workflow is also callable by `.github/workflows/release.yml`. A tag cannot reach its publish job until all four gates pass.

## Public package contract

The release set is derived from workspace manifests and checked against an explicit inventory, so adding or removing a public package requires a deliberate release-tool update. A package ships when it is not private and declares `publishConfig.access: public`. Every public package must:

- use the `@fabrika/*` scope;
- have the same source version as every other public package;
- use `workspace:*` for every dependency on another workspace package;
- depend only on public workspace packages at its published boundary; and
- participate in an acyclic dependency graph.

`scripts/release.ts` validates these rules and computes the dependency-first order. `release:validate` prints the set and its size; the inventory itself lives in the script.

## Local artifact verification

All commands require a `v<semver>` release tag. Outside a tag checkout, pass `--tag` explicitly:

```bash
bun run release:validate --tag=v1.2.3
bun run release:pack --tag=v1.2.3
bun run release:smoke --tag=v1.2.3
bun run release:publish --tag=v1.2.3 --dry-run
```

Packing copies each package into a temporary staging directory. It stamps the tag version, removes development dependencies and test files, and rewrites internal `workspace:*` ranges to the common released version. Source manifests remain unchanged.

The smoke command installs all tarballs into a temporary project with npm. It imports `@fabrika/app` and both providers, then executes `fabrika --help`. The publish dry-run checks npm's final package inputs without registry mutation.

Artifacts live under ignored `.release/`. Delete that directory or run `release:pack` again before evaluating a different tag.

## Tagged publication

A `v<semver>` tag starts `.github/workflows/release.yml` on a GitHub-hosted runner. The publish job receives `id-token: write`; no npm token is present. npm trusted publishing authenticates the exact workflow and generates provenance for each public package.

Packages publish in dependency order. A prerelease version uses the `next` dist-tag. On retry, the tool compares the registry's `dist.integrity` with the local tarball's SHA-512 integrity. It accepts an existing version only when the contents match and fails closed on a mismatch.

After publication, `release:registry-smoke` waits for the expected `latest` or `next` dist-tag on every public package, installs every exact version from npm into a clean project, verifies the installed manifests, imports the representative application/provider surfaces, and executes the installed CLI.

The wait is for npm's replication, not for the publish. A package has been observed reaching its dist-tag about five minutes after `npm publish` answered, so the smoke polls with backoff — 5 s, 10 s, 20 s, then 30 s steps — for up to ten minutes, printing the packages still missing between rounds and asking only about those. Past the deadline it fails with one line per package, naming what the registry answered. A release should no longer need a manual re-run of this step.

The workflow refuses to start publication while any package name is absent from npm. The one-time external activation procedure is tracked in [backlog 25](../backlog/25-bootstrap-npm-trusted-publishing.md).

## Pinning the standalone example

The standalone example repository described in [`examples/zerops-app/README.md`](../../examples/zerops-app/README.md) is a real consumer: it installs `@fabrika/*` from npm rather than from the workspace, so its `package.json` carries a version range that a release does not update by itself. A checkout pinned many releases back deploys many releases back.

Updating it is an operator step, run after the release is on npm, against a checkout of that repository:

```bash
bun scripts/release.ts example-pin /path/to/example-checkout --tag=v0.0.26
```

It rewrites every `@fabrika/*` range in every `package.json` under the given path to `^<released version>`, prints a unified diff of exactly the lines it changed, and commits and pushes nothing. Review the diff, then commit in that repository.

The command **refuses a path inside this repository**, and leaves a `workspace:` range alone wherever it finds one. Both guards exist for the same reason: `examples/*` are workspace members whose ranges match the workspace's own version so that bun links the local packages. Stamping a released range on them is silent — the next install fetches those packages from npm and the example stops exercising the working tree.

Nothing in CI checks the example's pins. Reading another repository would need a credential this repository deliberately does not hold, so the bump stays an operator step.

## Deployment boundary

The upstream repository verifies and distributes Fabrika. It does not deploy customer accounts.

Cloudflare installation creates a per-account repository whose workflow checks out the exact `fabrika.ref`. That workflow builds the runner image into the target account's own registry, then deploys IAM, Operations, the runner, and control. Active runner containers receive a 20-minute rollout grace before they become eligible for replacement.

Scaffold commits skip push CI because the GitHub Environment does not exist yet. `fabrika platform init` writes the account secrets and variables first, then explicitly dispatches the platform workflow.
