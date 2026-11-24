---
id: 0086
title: A Cloudflare deploy builds without credentials and deploys without the repository's code
status: accepted
date: 2026-11-24
---

# 0086 — A Cloudflare deploy builds without credentials and deploys without the repository's code

## Context

On Cloudflare the deploy runs in the runner container, which holds the installation's account-wide
`CLOUDFLARE_API_TOKEN`. Until now one process, `fabrika-cloudflare-executor deploy`, imported the checkout's
`fabrika.config.ts` after `bun install` of the checkout's own lockfile, ran `pipeline.build` and the checks, and then
provisioned and deployed with the token in its environment. The bounds on the generated configs limit what a config
_declares_. They cannot limit what its code _does_ at import time: read `process.env`, replace `fetch`, call the
Cloudflare API itself ([backlog 86](../backlog/86-a-cloudflare-deploy-holds-the-account-token-beside-the-repositorys-code.md)).
A `postinstall`, a `bunfig.toml` preload, a `tsconfig.json` path or a module the config imports reach the same
process. A child with the token removed from its environment could still read the executor's `/proc/<pid>/environ`,
because it ran as the same user.

That was tolerable while only a reviewed or pushed commit reached the runner. It is not once an agent deploys its own
commit to a stage environment through MCP ([ADR-0049](0049-author-applications-through-mcp-in-control.md)): a prompt
injection would then run code beside a credential that can replace every Worker of the account, Control and IAM
included. [ADR-0005](0005-compile-app-config-to-static-manifest.md) rejected exactly this ("execute it in the deploy
runner") for the control plane.

A list of protected files (lockfile, `bunfig.toml`, `tsconfig*.json`, …) that an agent may not change was considered
and rejected: the list is open-ended, it blocks every dependency change, and it does nothing about a child reading the
executor's environment.

## Decision

We will split every Cloudflare application deploy into a **build** that runs the repository's code with nothing worth
stealing, and a **deploy** that holds the credential and runs none of it. A protected environment's deploy takes the
same path as any other.

1. **The build runs in the build sandbox.** The runner image has a build user (`fabrika-build`, uid 10001). The runner
   (root) hands it the checkout and a build directory of its own (`<runId>.build`: home, temporary files, output) and
   runs each step through `setpriv` as that user, with no supplementary groups, no capabilities and no new privileges,
   and with exactly `PATH`, `HOME`, `TMPDIR` and `WRANGLER_SEND_METRICS` as its environment. The steps are `bun install
   --frozen-lockfile` in the checkout, `fabrika-cloudflare-executor build --fetch-tools` outside it (the tools the checks
   run, at the platform's pinned releases) and `fabrika-cloudflare-executor build`: the config, `pipeline.build`, the
   checks, wrangler's bundle (`deploy --dry-run --outdir`, which needs no account), and copies of the assets, the D1
   migrations and the source maps, described by a manifest (`fabrika-build.json`). After each step the runner kills
   every process of the build user, first with one `kill(-1)` as that user, which a process that keeps forking cannot
   outrun as it can a walk of `/proc`, and waits until none is left.
2. **The build holds no secret.** It never sees the Cloudflare credential, the clone token, the application's secrets
   or a managed credential. It reads two files: the access Control approved (the contract and two release numbers) and
   the build values, the operator's vars and the managed values that are not credentials (`buildValuesOf`, fail
   closed on `isManagedCredential`). `pipeline.build` gets the declared vars and those managed values in its
   environment. The runner writes the deploy's values file only after the build's processes are gone. As another user,
   the build cannot read `/proc/<pid>/environ` of the runner or the deploy executor, nor the runner's files beside the
   checkout (mode 0600, the workspace is root's).
3. **Network: the install has it, the build does not, where the container allows.** The install and the tool fetch
   reach the registry. The build runs in a network namespace of its own with only its loopback up (`unshare --net`),
   when the container allows one; the runner probes this once at start. Where it does not, `FABRIKA_RUNNER_BUILD_NETWORK=auto`
   (the image's default) builds with the container's network and the run log says so, and `isolated` refuses every
   run. The threat model decides the default: the build holds nothing secret, and what it builds is deployed with
   network and the stage environment's own secrets at runtime anyway. Denying the build network protects only the
   repository's source and the non-secret run data, which the author already has, and the runner's own port, which
   serves redacted logs and refuses a second run. It is defense in depth, not the boundary; the boundary is that no
   credential is in reach.
4. **The output reaches the deploy only through the runner's copy.** The runner creates a tree of its own and copies
   into it directories and regular files, each checked with `lstat` and again on the open descriptor (`O_NOFOLLOW`, same
   inode, `nlink` 1, unchanged size). A symbolic link, a hard link, a fifo, a socket, a device, a name that is not UTF-8
   or holds a control character or a backslash, more than 60,000 files, 1 GiB, 32 levels or a 1,024-byte path fails the
   deploy with one line (`copyBuildOutput`). The deploy then admits only the manifest, the application directory and
   the source maps at the top, and only the bundle, the assets, the staged SPA files and the migrations in the
   application directory, so nothing there is a file wrangler or a runtime reads on its own (`assertBuildLayout`).
5. **The deploy runs no repository code.** `fabrika-cloudflare-executor deploy --bundle=<copy>` runs in an empty
   directory of the runner with a private `TMPDIR`. It parses the manifest as JSON (a `__proto__` key anywhere is
   refused) against a strict schema and rebuilds the application's config from it out of its own oblaka classes: a
   resource from its kind and exactly the options its class takes, a D1 database's migrations only from the copy at
   `migrations/<binding>`, any other binding as the config entries its `configureBinding` wrote in the build, and the
   bundle as the Worker's `main`. Those entries are merged after the Worker's own, so a recorded binding may write
   exactly its own `services` entry or its own `ai` binding: with `main` replaced by a path in the checkout, `wrangler
   deploy --no-bundle` would read the checkout as root and upload what its links point at (`/proc/self/environ`, the
   values file), and a renamed Worker would be bundled. Before the first upload every generated config must be the
   application running the copied bundle or the platform's proxy. The composition (proxy, IAM identity, object, files bucket, managed values) and the
   bounds on the generated configs are the ones every deploy runs. The application Worker is uploaded with `wrangler
   deploy --no-bundle`; the platform's proxy Worker is bundled from the runner image's own source. The application id
   must be the one whose contract Control approved.
6. **What a build may describe.** The Worker's options are plain data. Its bindings are resources the deploy rebuilds
   (D1, KV, R2, queues, Durable Objects, workflows, Vectorize, Analytics Engine) or plain bindables (services, IAM, AI).
   A container (an image built from the checkout's Dockerfile) and a second Worker are refused in the build.
7. **A Control that relies on the isolated build says so in the job.** Every job's approved access carries
   `isolatedBuild: true`. The approved access is a strict object, so a runner older than this decision, which would
   still import the config beside the token, refuses the job ("Control runs a newer release than the runner") instead
   of running it. A runner that knows the field always builds isolated, with or without it. This also covers a run of a
   workspace branch started by hand. (The job's top level is not strict, so the marker lives in the approved access,
   which every non-dry job carries.)
8. **Nothing the agent can edit is evaluated by the deploy.** `fabrika.contract.ts`, its schema modules and
   `src/db/tables.ts` are read by Control's static reader, which runs nothing; the deploy takes the contract and digest
   from the approved access. The build evaluates them where it must (the tests, `fabrika app build`, the bundle), and
   the bundle runs them only in the deployed Worker.
9. **A local deploy and the installation's own components keep the single process** (`deploy --config`). They run
   code the operator chose to run, or fabrika's own.

**How this relates to ADR-0005.** ADR-0005 stands. The config is evaluated where the application's own code already
runs, its build, and the process that holds the credential consumes the build's data without importing it. The
manifest here is the Cloudflare deploy's internal hand-off, written by the platform's build executor inside the sandbox,
not ADR-0005's `fabrika.manifest.json`; Control still reads no manifest and executes nothing.

Of backlog 86's open points this closes the first: the config module no longer runs in the process that holds the
credential. The account-wide token and the naming rule that stands in for an ownership record remain (backlog 86).

**A separate account for agent-driven stage.** The job's credential is already per run (`CloudflareRunnerJob.credentials`,
exactly an account id and a token), and nothing below Control assumes it is the installation's. An environment could
name its own account and a vault secret for its token, which Control resolves into the job instead of the
installation's. That is not built: a Worker binds services only within its account, so an application in another
account could not bind IAM's Worker, its connectors' proxies or Operations, its oblaka state lives in that account, and
its domain's zone must be there too. It needs an IAM reachable across accounts first.

## Consequences

- An agent's commit can be built and deployed without its code meeting the account token. This is the runner boundary
  MCP authoring on Cloudflare needs; ADR-0049 rule 9 is unchanged until the rest of that work lands.
- `pipeline.build` no longer gets the application's secrets or the managed credentials, which it did. A build that read
  a secret fails; it should read a var, or the value should be the Worker's at runtime.
- The checks and the bundler run beside the application's own tests in one sandbox, so a hostile test can still make a
  check pass; the checks guard mistakes. What they guard no longer includes a credential.
- Tests that reach the network fail when the container isolates the build's network.
- A config that binds a container, a Worker of its own or a binding with options that are not plain data cannot deploy.
- The runner image gains the build user, `iproute2`, and Bun and wrangler under `/opt/bun`. Upgrade: the installation's
  workflow builds the image from `fabrika.ref` on every run, so the next platform deploy builds and deploys the new
  runner before Control (the pair form). The job between Control and the runner is unchanged, generated files and
  environment variables are unchanged, and resource names and the oblaka state namespace are the same, so an existing
  installation converges with no step of its own.
- Not yet verified on a live Cloudflare container: whether it allows a network namespace (the runner then logs `Build
  network: open`) and the `setpriv` switch, which the image smoke proves under Docker.

## Alternatives considered

- **Protected files.** Rejected for the reasons in Context.
- **Run only the checkout's children as another user, keep importing the config in the executor.** Leaves the config
  module, and everything it imports, beside the token.
- **A second container per run for the build.** A separate VM is a stronger boundary than a separate user, but doubles
  the cold start and needs the output carried between containers through R2. The manifest and the copier are the same
  either way, so this remains open.
- **Always require a network namespace.** Fails closed on a container we have not measured, for a protection the threat
  model above does not need. Available as `isolated`.
- **Scope the token per run.** A Cloudflare token cannot be limited to one Worker or one D1 database; this is backlog 86's
  second part.
