# Verification and release process

This repository verifies every pull request and `main` push. Version tags reuse the same verification workflow before publishing one co-versioned set of public packages.

## Repository CI

`.github/workflows/ci.yml` has four independent gates:

1. **Quality** installs the frozen Bun lockfile, checks formatting and lint, typechecks every workspace package and the release tool, and verifies generated Zerops artifacts.
2. **Backend tests** run the complete Bun suite once per supported PostgreSQL major (17 and 18; Zerops runs 18), each with an authenticated SeaweedFS 4.42 `mini` instance. Startup creates `fabrika-test`; readiness checks its filer directory. Telemetry and implicit bucket creation are disabled. `FABRIKA_TEST_POSTGRES_URL` and every required `FABRIKA_TEST_S3_*` value are present, so opt-in integration suites cannot become skips.
3. **Deployable builds** build the unified dashboard and the Bun proxy executable. The proxy build uses a committed empty manifest, proving the binary and a fail-closed generated Caddy configuration without relying on local deployment state.
4. **Release artifacts** stage, pack, install, import, and dry-run-publish every public package at a disposable prerelease version.

The workflow is also callable by `.github/workflows/release.yml`. A tag cannot reach its publish job until all four gates pass.

### The same gates locally

`bun run check:ci` (`scripts/check-ci.ts`) runs every `run` step of `ci.yml` in order: the frozen install once, the quality steps, the test suite, the builds and the release-artifact steps. It stops at the first failing step and names it.

- **PostgreSQL.** When `FABRIKA_TEST_POSTGRES_URL` is unset and docker answers, it runs the test suite once per major of the CI matrix, each against a throwaway `postgres:<major>-alpine` container on a random loopback port, removed after its run. A set `FABRIKA_TEST_POSTGRES_URL` is used for one run instead of the matrix.
- **S3.** When `FABRIKA_TEST_S3_ENDPOINT` is unset and docker answers, it starts the same SeaweedFS `mini` instance as CI on a random loopback port and sets every `FABRIKA_TEST_S3_*` value. Otherwise the environment's own values are used as they are.
- **Release artifacts** need npm on `PATH`, as CI gets it from `setup-node`.

Whatever it could not run — a backend without docker, the matrix replaced by a given database, the release-artifact steps without npm — it lists under `SKIPPED` at the end, with the duration of every step that ran. `scripts/__tests__/check-ci.test.ts` fails when its steps, the PostgreSQL majors, the images or the S3 values drift from `ci.yml`.

## Public package contract

The release set is derived from workspace manifests and checked against an explicit inventory, so adding or removing a public package requires a deliberate release-tool update. A package ships when it is not private and declares `publishConfig.access: public`. Every public package must:

- use the `@fabrika/*` scope, except `agent-canvas`, which keeps its established unscoped npm name (`UNSCOPED_PUBLIC_PACKAGES`);
- have the same source version as every other public package, and as the release tag (see [The source version](#the-source-version));
- use `workspace:*` for every dependency on another workspace package;
- depend only on public workspace packages at its published boundary; and
- participate in an acyclic dependency graph.

`scripts/release.ts` validates these rules and computes the dependency-first order. A package without a library entry, such as the `agent-canvas` command, is smoked by running its command instead of importing it (`COMMAND_ONLY_PACKAGES`). `release:validate` prints the set and its size; the inventory itself lives in the script.

## The source version

The source tree carries the version of its next release. An installation does not install the tarballs: it runs the git checkout of its pinned tag, so code that reads its own `package.json` there reads the source version. Control reads an application of its own minor with its own reader and records that version as the snapshot's checker (`CHECKER_VERSION`), and `platform install` asks npm for `@fabrika/check` at that version (`FABRIKA_CHECK_VERSION`). Both are right only when the tag's commit carries the tag's version.

When the development of a minor that breaks the framework starts, the source version moves to that minor first (`release:bump --tag=v0.7.0`, before the first breaking change). Otherwise the source still carries the previous minor's newest release, and bun links the bundled reader of that minor to the working tree instead of installing it from npm ([The framework window](#the-framework-window)).

`release:validate` therefore refuses a tag whose version differs from the source version, and the release workflow stops before anything is packed. Set the version before tagging:

```bash
bun run release:bump --tag=v1.2.3
```

`bump` refuses a version that is not newer than the source. It writes the version into every workspace package that declares one, pins the `@fabrika/*` dependencies of `examples/*` to exactly `1.2.3`, which keeps bun linking the workspace, and stamps the application skill: `SKILL.md`'s version and the example pins of its references. It renders the template's `AGENTS.md` from that skill again, runs `bun install` for the lockfile, and re-pins the local stack's Notes source fixture (`fixtures:pin`), whose tree holds that template. It commits nothing.

Between the bump commit and the publish of its tag, the source names a version npm does not have yet. On Zerops `fabrika platform install` and `deploy` refuse such a checkout ([`zerops-platform.md`](zerops-platform.md#the-checker-version)), so a source install from `main` works again once the tag is published.

## The framework window

A platform release deploys applications on every framework minor of its window ([ADR-0062](../decisions/0062-a-platform-release-serves-older-framework-releases.md)): the six months before it, never fewer than the two minors before its own. Control reads an application's `@fabrika/app` release from the `bun.lock` at its root and reads the contract with the reader of that minor (`packages/control/src/approval/readers.ts`). It refuses a release outside the window, or newer than the platform, at deploy with one line; the running version keeps running. The first release under this rule is 0.7: its window is 0.4, 0.5, 0.6 and 0.7, and it bundles the readers 0.4.8, 0.5.5 and 0.6.0. 0.8's window is 0.4, 0.5, 0.6, 0.7 and 0.8, every minor of the six months before it, and it bundles the readers 0.4.8, 0.5.5, 0.6.0 and 0.7.0. 0.9's window adds 0.9, and it bundles the readers 0.4.8, 0.5.5, 0.6.0, 0.7.0 and 0.8.2.

- **Readers.** This release's own `@fabrika/check` reads its own minor. Each older minor's newest patch is bundled in `packages/control/package.json` as exact npm aliases: `@fabrika/check-0.<minor>`, with `@fabrika/app-0.<minor>` and `@fabrika/auth-core-0.<minor>` for its artifact schema and digest, and `@fabrika/proxy-core-0.<minor>` (0.4.8, 0.5.5, 0.6.0, 0.7.0 and 0.8.2 today). The proxy-core aliases of 0.4.8, 0.5.5 and 0.6.0 are the row and CSP parsers that judge a deploy to a Zerops namespace whose proxy is pinned to an older source (`src/zerops/older-proxies.ts`); the 0.7.0 and 0.8.2 ones only feed `framework-compat.test.ts`. No minor newer than 0.6 becomes such a judge while Control does not record a pin's release: the provider deploys what any judge parses, so a newer judge lets that minor's forms reach a namespace pinned below it, whose strict parser refuses the whole manifest ([ADR-0022](../decisions/0022-the-proxy-is-the-only-enforcement-point.md)). Raise an alias when that minor gets a newer patch. When a minor leaves the window, delete its aliases, its reader and its upcast rule in the release that names what it retired.
- **Artifact formats.** The artifact names its `format`; the 0.4, 0.5 and 0.6 artifacts have none, and 0.6.0's is 0.5.5's unchanged. 0.7's is format 2, which 0.8 only extended with optional forms and 0.9 did not change, so a 0.7 or 0.8 artifact is kept and read as it is. A release that changes the artifact raises `CONTRACT_FORMAT` and adds an upcast rule from every older format of the window to the new model (`packages/control/src/approval/formats.ts`). A snapshot stores and digests the artifact as its release read it, and the application's contract digest is the one its own release computes.
- **The build step.** A Zerops build runs `fabrika-check` and `fabrika-source-maps` of `@fabrika/check` at the release of the reader that read the application, the newest patch of its minor, not the installation's.
- **The compatibility test.** `packages/control/src/__tests__/framework-compat.test.ts` reads one application of every older minor of the window through Control's read path (`fixtures/`: the CRM at v0.4.8, v0.5.4, v0.6.0, v0.7.0, v0.8.1 and v0.8.2, an application with form files at v0.5.5, and a webhook application at v0.5.5) and compares it with that release's npm packages and with what that release's own Control recorded. When the window gains or loses a minor, record or delete its fixture from that release's tag. `provider-zerops`'s `released-manifest.test.ts` parses the manifests the 0.4.8 and 0.7.0 CLIs wrote (0.8.1's are 0.7.0's bytes).

An application pins an exact release inside its installation's window. The MCP authoring rules describe the installation's own release; an application on an older one follows the skill in its own `node_modules`.

## The Bun version

`.bun-version` at the repository root names the one exact Bun release this repository is built, tested and released with. Bun itself ignores the file. Every place that installs Bun follows it:

- Every `setup-bun` step of `ci.yml` and `release.yml` reads it with `bun-version-file`.
- The runner image copies it and passes it to the Bun installer.
- Both generated sidecar workflows read it from the checkout of the pinned `fabrika.ref`, so an installation installs the Bun its tag was released with. A newer Bun can rewrite the lockfile, which `bun install --frozen-lockfile` refuses. A tag up to v0.4.3 has no `.bun-version`; the workflow then installs 1.3.14, the release all of those tags were built with. The workflows never install `latest`.
- The local stack's `oven/bun:<version>-alpine` images (`packages/local-stack/compose.yaml` and `app-image/Dockerfile`) repeat it, because an image tag cannot read a file.

To move to another Bun, change `.bun-version` and the two local-stack image tags, run `bun install` so the lockfile is the one that Bun writes, and land it before the release it should ship with. `scripts/__tests__/bun-version.test.ts` fails when a CI step, the runner image or a local-stack image does not follow the file.

The Zerops platform services build and run on the `alpine/bun@1.3` base. Zerops resolves that alias to the newest concrete 1.3 release in its catalog ([`zerops-platform.md`](zerops-platform.md)), and offers no way to name `.bun-version` there.

## Cutting a release

1. On an up-to-date `main`, run `bun run release:bump --tag=v1.2.3`, review the diff, and run `bun run format` and `bun run check:ci`.
2. Commit the result as `chore: release v1.2.3` and land it on `main`.
3. Tag that commit `v1.2.3` and push the tag. `.github/workflows/release.yml` verifies, validates, packs, smokes, publishes and runs the registry smoke.

## Cutting a hotfix

A hotfix is the last release plus some commits, not `main`. One command builds it:

```bash
bun run release:hotfix --from=v1.2.3 --tag=v1.2.4 <commit>... [--push]
```

It works in a temporary git worktree of the same repository, so the caller's checkout, branch and uncommitted files do not change, and a red or dirty `main` does not matter. In that worktree it:

1. creates the branch `hotfix/v1.2.4` from the tag `v1.2.3`;
2. cherry-picks each commit with `-x`, in the given order;
3. runs `bun install --frozen-lockfile` and the `release:bump` of the `--from` source, not of the caller's checkout;
4. commits the result as `chore: release v1.2.4`;
5. runs `release:validate` of that source;
6. creates the annotated tag `v1.2.4`, then removes the worktree.

Without `--push` it prints the push command, `git push origin hotfix/v1.2.4 v1.2.4`; with `--push` it runs it. The tag push starts `release.yml`, whose `verify` job runs the full CI against the tagged commit before anything is published. The command runs no tests of its own.

It refuses a `--from` that is not a local tag, a `--tag` that does not move past it, and a tag or branch that already exists. When a commit does not apply, the bump leaves an untracked file, or the validation fails, it removes the worktree and the branch, so a re-run starts clean. A commit that conflicts needs a back-port: make it on a branch off the `--from` tag and pass that commit instead.

The release commit stays on the hotfix branch. `main` keeps its source version, so the next release from `main` must take a version past the hotfix.

## Local artifact verification

All commands except `pack --local` (below) require a `v<semver>` release tag. Outside a tag checkout, pass `--tag` explicitly. `validate` also requires the tag to equal the source version; `pack`, `smoke` and `publish` do not, so CI packs its disposable `v0.0.0-ci.0`:

```bash
bun run release:validate --tag=v1.2.3
bun run release:pack --tag=v1.2.3
bun run release:smoke --tag=v1.2.3
bun run release:publish --tag=v1.2.3 --dry-run
```

Packing copies each package into a temporary staging directory. It stamps the tag version, removes development dependencies and test files, and rewrites internal `workspace:*` ranges to the common released version. For a release tag the stamped version is the source version already; the stamp matters for the CI and local packs. Source manifests remain unchanged.

### Declarations

A public package ships its TypeScript sources, which Bun runs, and a declaration file for each of them, which an application's type check reads ([ADR-0068](../decisions/0068-public-packages-ship-declarations-beside-their-sources.md)). `skipLibCheck` skips declarations but not a `.ts` file, so without them an application's type check would check the framework's sources too.

- **Pack.** Packing emits the declarations of every shipped module into `types/` of the staged copy, which mirrors the package (`./src/index.ts` → `./types/src/index.d.ts`). It uses the compiler options of the package's own `tsconfig.json`. In the staged manifest every `types` condition names the declaration, a bare TypeScript target of `exports` or `imports` gains a `types` condition, and `files` gains `types`. `bun` and `default` keep the source. Any diagnostic of the emit fails the pack. So does an import in a declaration that is not a declared public dependency. The workspace manifests are not changed: in this repository `types` names the source, and nothing needs a build.
- **Smoke.** Both `smoke` and `registry-smoke` type-check every typed entry of every package in the isolated consumer. They use the compiler options of the platform build's type check with `skipLibCheck` off, and `compilerOptions.types` of the package's own `tsconfig.json`. The consumer also installs the ambient type packages (`@types/*`, `@cloudflare/workers-types`) that the public packages develop against, at the versions this checkout installed. The smoke fails when an entry does not resolve, when a declaration has an error, or when the check reads a `@fabrika/*` source instead of a declaration.
- **Compiler.** The repository's `typescript` writes the declarations. It must be the release that the Zerops build runs (`PLATFORM_TYPESCRIPT_VERSION`). `scripts/__tests__/declarations.test.ts` fails when the two differ, so bump them together.

The smoke command installs all tarballs into a temporary project with npm. It imports `@fabrika/app` and both providers, executes `fabrika --help`, and type-checks the declarations ([Declarations](#declarations)). The publish dry-run checks npm's final package inputs without registry mutation.

Artifacts live under ignored `.release/`. Delete that directory or run `release:pack` again before evaluating a different tag.

Every pack records each tarball's sha512 integrity in `release-manifest.json`.

## A local pack for an application outside the repository

`bun run release:pack --local --artifacts=<dir>` needs no tag. It versions the set `<source version>-local.g<short sha>`, a prerelease npm never has: packed from 0.7.0 source it is `0.7.0-local.g<sha>`, so `fabrika-check` and the skill name the minor the code is. The skill's example pins keep the published version, so an application copied from them still installs. Beside the tarballs and `release-manifest.json` it writes `install.json`: a `dependencies` and an `overrides` block that name every tarball as `file:vendor/<tarball>`. Each packed manifest names its `@fabrika/*` dependencies by the local range, so only the overrides keep the whole graph local.

The application copies the tarballs into `vendor/`, takes the block in place of its `@fabrika/*` entries and runs `bun install`. `fabrika-check` refuses that form unless it is run with `--packed <dir>/release-manifest.json`, and then accepts only tarballs whose bytes match the recorded integrity ([ADR-0043](../decisions/0043-validate-and-render-one-zerops-descriptor-meaning.md)). The platform build never passes the flag, so such an application does not deploy. `FABRIKA_TEST_RELEASE_PACK=1 bun test scripts/__tests__/release.test.ts` runs that whole path against npm.

## Release channels

The version decides the npm dist-tag a release publishes under. One function, `releaseDistTag` in `scripts/release.ts`, derives it for both `publish` and `registry-smoke`. A prerelease whose first identifier is a channel of `RELEASE_CHANNELS` publishes under that channel:

| Version                                                 | Dist-tag     | Cut from             |
| ------------------------------------------------------- | ------------ | -------------------- |
| a release (`0.9.0`)                                     | `latest`     | `main`               |
| `<version>-cloudflare.<n>` (`0.9.0-cloudflare.1`)       | `cloudflare` | `channel/cloudflare` |
| `<version>-alpha.<n>` (`0.9.0-alpha.1`)                 | `alpha`      | `channel/alpha`      |
| any other prerelease (`0.9.0-dev.4`, CI's `0.0.0-ci.0`) | `next`       | any branch           |

A prerelease never moves `latest`, and the `example-mirror` job of `release.yml` skips every prerelease, so the standalone example keeps following `latest` ([Pinning the standalone example](#pinning-the-standalone-example)). Adding a channel is a deliberate edit of `RELEASE_CHANNELS`.

The Cloudflare provider's release gates (`packages/provider-cloudflare/src/contract-support.ts`) read the application's pin in two ways, and only one of them ignores the channel:

- **Minor gates** (`releaseAtLeast`: the object runtime, the pinned entry, the ops channel) read a prerelease as its minor, so every 0.9.0 prerelease is a 0.9 application to them, whatever its channel.
- **Release floors** (`releaseFrom`) compare SemVer precedence, prerelease included. The alarm, the job segment cap, the data operations and raw SQL start at `0.9.0-dev.5`. Every `0.9.0-cloudflare.<n>` and `0.9.0-alpha.<n>` sorts below it ([Ordering](#ordering)), so an application pinned to one gets none of them, even when its channel release was cut from a `main` that has them. Before the next channel release, see [backlog 240](../backlog/240-channel-prereleases-sort-below-the-release-floors.md).

### A channel branch

A channel ships what `main` has before `main` releases it, without moving `main`'s source version. Its releases are cut from a long-lived branch `channel/<name>`, which follows `main` and carries only the release commits of its own versions on top. `main` keeps its source version; the channel branch carries the channel's version. CI runs on every push to a `channel/**` branch and on every pull request into one, as it does for `main`.

A channel branch must contain the release tooling that knows channels (`RELEASE_CHANNELS` in `scripts/release.ts`). A tag runs the `release.ts` of its own commit, so a channel tag cut from a commit without it refuses the bump or publishes under `next`. For the same reason a hotfix into a channel starts only from a tag of that channel (`release:hotfix --from=v0.9.0-cloudflare.1 --tag=v0.9.0-cloudflare.2`), never from an older tag cut before the channel existed.

To cut the next release of a channel:

1. Merge `main` into `channel/<name>` (a merge, so the branch keeps the tags it published).
2. Run `bun run release:bump --tag=v0.9.0-cloudflare.2`, then `bun run format` and `bun run check:ci`. A merge of `main` brings `main`'s source version back into the conflicting manifests; the bump overwrites them.
3. Commit the result as `chore: release v0.9.0-cloudflare.2`, push the branch, tag that commit and push the tag.

A channel hotfix ([Cutting a hotfix](#cutting-a-hotfix)) leaves its release commit and tag on `hotfix/<tag>`, not on `channel/<name>`. The channel branch keeps its source version, so its next release must take a version past the hotfix.

`release.yml` starts on a `v*` tag whatever branch the commit is on. Its `verify` job runs `ci.yml` against the tagged commit, `release:validate` refuses a tag that differs from the source version, and npm trusted publishing names the repository and `release.yml`, not a branch.

### Ordering

`release:bump` refuses a version that is not newer than the source, within one dist-tag. A prerelease source may switch to another channel's prerelease of the same release or a later one, although SemVer may order it lower: SemVer orders prerelease identifiers by ASCII, so `0.9.0-cloudflare.1` sorts below `0.9.0-dev.4`, and the bump from `dev.4` to `cloudflare.1` passes. Going back within a channel (`cloudflare.2` to `cloudflare.1`), between two prereleases that share `next` (`dev.4` to `beta.1`), to an older release, or from a release to a prerelease of it, is refused.

The bump compares with the source only, not with the target channel's dist-tag on npm. A switch to a version below what that dist-tag already names, such as `cloudflare.2` to `0.9.0-dev.1` when `next` is at `dev.4`, passes the bump; `release:publish` then refuses it before it publishes anything, because it refuses a version older than its dist-tag. Pick the next version of the target channel.

A caret range such as `^0.9.0-cloudflare.1` therefore resolves `0.9.0-dev.4`. That does not reach an application that follows the rule: every `@fabrika/*` pin is an exact version ([Pinning the standalone example](#pinning-the-standalone-example)), and the application skill's example pins are exact.

## Tagged publication

A `v<semver>` tag starts `.github/workflows/release.yml` on a GitHub-hosted runner. The publish job receives `id-token: write`; no npm token is present. npm trusted publishing authenticates the exact workflow and generates provenance for each public package.

Packages publish in dependency order, under the dist-tag of their channel ([Release channels](#release-channels)). On retry, the tool compares the registry's `dist.integrity` with the local tarball's SHA-512 integrity. It accepts an existing version only when the contents match and fails closed on a mismatch.

After publication, `release:registry-smoke` waits for the channel's dist-tag on every public package, installs every exact version from npm into a clean project, verifies the installed manifests, imports the representative application/provider surfaces, and executes the installed CLI.

The wait is for npm's replication, not for the publish. A package has been observed reaching its dist-tag about five minutes after `npm publish` answered, so the smoke polls with backoff — 5 s, 10 s, 20 s, then 30 s steps — for up to ten minutes, printing the packages still missing between rounds and asking only about those. Past the deadline it fails with one line per package, naming what the registry answered. A release should no longer need a manual re-run of this step.

The workflow refuses to start publication while any package name is absent from npm. npm trusted publishing cannot create a package name, so a new public package needs one interactive first publish and an `npm trust` binding to `release.yml` by an npm owner before CI can publish it.

## Pinning the standalone example

The standalone example repository described in [`examples/zerops-app/README.md`](../../examples/zerops-app/README.md) is a real consumer: it installs `@fabrika/*` from npm rather than from the workspace. An application pins an exact release inside its installation's window ([The framework window](#the-framework-window)), so every `@fabrika/*` pin is an exact version, never a range. A range such as `^0.4.5` resolves a later patch, and the co-versioned set then mixes releases. The packed packages pin their `@fabrika/*` dependencies exactly for the same reason.

`example-pin` writes those pins in a checkout of another repository:

```bash
bun scripts/release.ts example-pin /path/to/example-checkout --tag=v0.0.26
```

It pins every `@fabrika/*` dependency in every `package.json` under the given path to exactly `<released version>`, prints a unified diff of exactly the lines it changed, and commits and pushes nothing.

The command **refuses a path inside this repository**, and leaves a `workspace:` range alone wherever it finds one. Both guards exist for the same reason: `examples/*` are workspace members whose pins match the workspace's own version so that bun links the local packages. Stamping a released version on them is silent: the next install fetches those packages from npm and the example stops exercising the working tree.

The `example-mirror` job of `release.yml` refreshes the mirror after every release that is not a prerelease, once `publish` and its registry smoke have passed. It runs the procedure of the example's README: it exports `examples/zerops-app` at the tag, runs `example-pin` and `bun install`, checks a frozen install, the type check and `fabrika-check`, and pushes one commit to the mirror's `main`. It pushes with a write deploy key of the mirror repository, held in the `EXAMPLE_MIRROR_DEPLOY_KEY` secret of this repository. Without that secret the job prints a notice and changes nothing; then run the README procedure by hand.

## Deployment boundary

The upstream repository verifies and distributes Fabrika. It does not deploy customer accounts.

Cloudflare installation creates a per-account repository whose workflow checks out the exact `fabrika.ref`. That workflow builds the runner image into the target account's own registry, then deploys IAM, Operations, the runner, and control. Active runner containers receive a 20-minute rollout grace before they become eligible for replacement.

The detached runner Worker and its image must be rolled forward before Control
when introducing the exact-source protocol
([ADR-0048](../decisions/0048-bind-cloudflare-delivery-to-the-recorded-commit.md)).
Both come from the operator's pinned checkout. Custom Control compositions must
supply immutable `resolveSource` and URL-only `prepareClone` collaborators. The clone result type is
`CloudflareCloneSource`; non-dry runner refs are complete lowercase 40-hex commits.

Roll the runner Worker and image forward before Control. Nothing detects the
reverse order: an outdated runner may ignore the expected commit
([ADR-0048](../decisions/0048-bind-cloudflare-delivery-to-the-recorded-commit.md)).
With matching components, a non-dry job fetches the exact commit, compares the
detached HEAD, and only then installs dependencies.

The runner addresses each run's container by a name keyed with `FABRIKA_RUNNER_KEY`. A runner upgrade
from a version that named containers by the run id, or a key rotation, no longer reaches a run already
in flight: deploy it with no Cloudflare run in flight. The transition is described in
[backlog 89](../backlog/89-another-worker-can-still-start-its-own-runner-containers.md).

Local Git and package checks verify offline source identity and consumer contracts.
Live GitHub authorization, Cloudflare RPC/image exchange and account rollout
require separate operator-owned acceptance evidence.

A Zerops installation rolls forward with one command: `fabrika platform upgrade --provider=zerops --to=<tag>` verifies the tag exists on this repository, writes `fabrika.ref` in the sidecar checkout, rewrites the sidecar workflow when it differs from the one the running CLI generates, commits and pushes both, prints the workflow run URL and watches the run to its end. The sidecar builds `iam` and `operations` concurrently, then `proxy`, then `control`.

A Cloudflare installation has no `platform upgrade`: the operator bumps `fabrika.ref` in the per-account repository and pushes it. That push does not rewrite the sidecar workflow. Re-running `fabrika platform init --provider=cloudflare <account>` with the same flags does: it rewrites the CLI-owned `platform.yml`, `README.md` and `.gitignore` to the ones the running CLI generates, keeps `fabrika.ref`, and dispatches the workflow. Run it with the CLI of the release the pin names.

Scaffold commits skip push CI because the GitHub Environment does not exist yet. `fabrika platform init` writes the account secrets and variables first, then explicitly dispatches the platform workflow.
