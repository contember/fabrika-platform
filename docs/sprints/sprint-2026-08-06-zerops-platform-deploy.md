# Sprint — an unattended `platform deploy` on Zerops (2026-08-06)

**Goal.** `fabrika platform deploy --provider=zerops` brings a Zerops installation to HEAD from a
clean environment, unattended, idempotently — no `zops` invocation and no hand step.

**Theme.** [ADR-0025](../decisions/0025-the-operator-installs-the-platform-fabrika-deploys-apps.md)
makes this command the public interface an operator's pipeline calls. Everything else in the install
story waits on it: the sidecar repository generates the caller (since shipped and proven live —
[archive](../archive/sprint-2026-08-07-zerops-from-scratch-install.md)), and
[63](../backlog/63-a-one-click-install-from-the-public-repository.md) is the same sequence driven from
elsewhere. Backlog [58](../backlog/58-generate-the-platform-installations-proxy-manifest.md)
and [59](../backlog/59-the-live-installation-calls-itself-local.md) are not siblings of
[61](../backlog/61-make-platform-deploy-an-unattended-command.md) — they are steps inside it, which
is why they are WUs here rather than separate items.

## Refs re-verified at HEAD (2026-08-06)

- ✔ Zerops supports `plan` only — `packages/installation-zerops/src/index.ts:16` (`commands: ['plan']`),
  and `run` throws for anything else (`:19-21`).
- ✔ Cloudflare supports all three — `packages/installation-cloudflare/src/installation.ts:52`.
- ⚠ **The backlog is wrong about Cloudflare in two places.** 62 says "Nothing produces the caller";
  `packages/installation-cloudflare/src/templates/` already holds the vozka three-file shape
  (`platform.yml`, `fabrika.ref`, `README.md`, plus `gitignore`), scaffolded by `scaffold.ts` and
  populated by `environment.ts`. And 61 says the contract should own the deploy order; on Cloudflare
  it does not — the order is three separate steps in the scaffolded workflow
  (`templates/platform.yml:96`, `:123`, `:136`), and `deployPlatform` composes only the runner+control
  pair (`installation.ts:14-33`). Both items need rewriting at close.
- ✔ `localPlatformProxyManifest` builds the three-app platform manifest with `*.fabrika.localhost`
  hosts, `upstream: 'iam:18080'`-style authorities and `scheme: 'http'` hard-coded —
  `packages/local-stack/src/prepare.ts:132-158`.
- ✔ Its gate inputs are the live ones: `CONTROL_PROXY_GATES` (`packages/control/fabrika.gates.ts:29`),
  `OPERATIONS_PROXY_GATES` (`packages/operations/src/gates.ts:28`), `OPERATIONS_APP_ID = 'operations'`
  (`packages/operations-contract/src/access.ts:8`). IAM's own rule is a literal
  `{ path: '/*', kind: 'public' }` written inline at `prepare.ts:140`.
- ⚠ IAM's app id in that manifest is `'iam-local'` (`prepare.ts:135`) and the console's is `'vozka'`
  (`:144`). Whether `iam-local` is the right id for a deployed installation is open — settle it in WU1
  before the generator hard-codes either answer.
- ✔ The Zerops API client already has every call this sprint needs: `putServiceEnv` (`:346`),
  `listServiceEnv` (`:335`), `deleteServiceEnv` (`:349`), `triggerPipeline` (`:253`), `getAppVersion`
  (`:265`), `latestAppVersion` (`:274`), `enableSubdomainAccess` (`:294`), `findService` (`:302`),
  `listProjectServices` (`:323`), `getLogAccess` (`:360`), `readBuildLog` (`:373`) —
  `packages/provider-zerops/src/api.ts`. **No new integration is required, only orchestration.**
- ✔ The light topology is `db`, `storage`, `iam`, `operations`, `control`, `proxy` in one project —
  `packages/installation-zerops/zerops/topology.ts:300-353`.
- ✔ `reconcileSchema` refuses an empty `returnOrigins` rather than clearing the registry —
  `packages/auth/src/provision.ts:85-89`.
- ✔ Live account reachable: `zops project list` shows `fabrika-test` ACTIVE, LIGHT.

## Work units

### WU1 — Generate the installation's proxy manifest (effort S–M) · closes backlog 58

- **Problem.** Nothing generates `FABRIKA_PROXY_MANIFEST_JSON` for a deployed installation. The live
  document was hand-written and drifted one app wide, unreported: control was gated
  `{ path: '/*', kind: 'public' }` while `CONTROL_PROXY_GATES` had declared fourteen `human`/`service`
  rules since `2c89ab9`. Nothing reported it — not `local:smoke`, not a test, not a deploy.
- **Verify first.** Settle the `iam-local` app id question above. Read the LIVE manifest on
  `fabrika-test` and diff it against what the new generator emits, before changing anything.
- **Scope.** A generator taking the installation's hosts and emitting the three apps from the same
  gate imports `localPlatformProxyManifest` makes. `prepare.ts` becomes a CALLER of it, not a copy —
  otherwise the local stack is a second definition of the same document.
- **Acceptance / witness.** A test pinning the generated manifest's app ids and hosts against the
  installation topology's service list (the local stack's `app-registration.test.ts` is the shape),
  plus a `--check` comparison an operator can run against a live service's variable.
- **Touch points.** `packages/installation-zerops/zerops/`, `packages/installation-cloudflare/`,
  `packages/local-stack/src/prepare.ts`.

### WU2 — `platform deploy --provider=zerops` (effort L) · closes backlog 61

- **Problem.** The command does not exist. Bringing `fabrika-test` to HEAD on 2026-08-05 took
  `zops push` from a laptop, once per service, in a hand-chosen order; everything that made that run
  correct lives in a run log.
- **Verify first.** Read back the live services and their env keys (`listProjectServices`,
  `listServiceEnv`) and compare against what the topology says should exist. Do not print values.
- **Scope, in order.** Resolve project + services by hostname → write env (WU1's manifest, WU3's
  environment name, per-service config) → deploy **IAM → Operations → proxy → control**, waiting for
  each to become ready → `reconcileSchema` for the console's app id → ensure the proxy's subdomain.
  Fail closed: a deploy that cannot apply the manifest must not leave the previous manifest in front
  of new code.
- **Acceptance / witness.** `fabrika-test` reaches HEAD by this command alone from a clean
  environment; a re-run changes nothing; an anonymous `GET /api/*` is refused by the proxy before and
  after.
- **Touch points.** `packages/installation-zerops/`, `packages/installation-contract/`,
  `packages/cli/`, `packages/provider-zerops/`.

### WU3 — A service refuses to boot as `local` when it is not (effort S) · closes backlog 59

- **Problem.** `control` and `operations` on `fabrika-test` carry `ENVIRONMENT=local`; IAM carries
  `stage`. Harmless at HEAD — the value reaches only a log line in those two Bun processes — but
  `local` is precisely the value every bypass is gated on (`localDevLogin`, the ephemeral signing key,
  the credential-less caller path). The drift exists because nothing writes these variables as part of
  a deploy.
- **Scope.** WU2 writes the environment name on every service. Beyond that, the decision taken for
  this sprint: **fail closed** — a service that can see it is not local refuses to boot with
  `ENVIRONMENT=local`, consistent with `readProxyEnv` and with `buildOidc`. Also delete the inert
  `LOCAL_DEV_LOGIN` from the live IAM rather than leaving a switch on a public identity service.
- **Acceptance / witness.** Every service on `fabrika-test` reads back the same non-`local`
  environment name; no `LOCAL_DEV_LOGIN` key exists on the installation; a unit test proves the
  refusal on both runtimes.
- **Touch points.** `packages/*/src/node/runtime.ts`, `packages/iam/src/services.ts`, the live
  service variables.

### WU4 — `platform init --provider=zerops` and the sidecar repository (effort M) · closes backlog 62

- **Problem.** Nothing produces the caller for Zerops. `platform deploy` is the public interface an
  operator's pipeline invokes, and ADR-0025 forbids that pipeline living in this repository. Note that
  backlog 62's "Nothing produces the caller" is only true of Zerops:
  `packages/installation-cloudflare/src/templates/` already ships the three-file shape, scaffolded by
  `scaffold.ts` and populated by `environment.ts`.
- **Verify first.** Read the Cloudflare init end to end and decide what is genuinely shared versus what
  merely looks alike. **The two are not mirror images**: Cloudflare builds a runner image on first
  bring-up and needs a GitHub App; Zerops has no runner (ADR-0003) and needs the one-time GitHub↔Zerops
  OAuth link instead (backlog 47). What should be shared is `scaffold.ts` and `environment.ts`, not the
  flow.
- **Scope.** Zerops templates (`platform.yml`, `fabrika.ref`, `README.md`, `gitignore`) whose workflow
  calls WU2's CLI surface; `runInit` for Zerops per decisions 4 and 5. Pin a **tag**, and refuse a
  branch — ADR-0025 makes published tags load-bearing.
- **Acceptance / witness.** A generated sidecar repository deploys the `fabrika-test` installation with
  no step taken inside this repository, and bumping its pinned ref rolls the installation forward.
  That run is the sprint's live acceptance and closes backlog 61 as well.
- **Open question to settle, not inherit.** The predecessor seeded `VOZKA_BOOTSTRAP_ADMINS` and told
  the operator to reset it to `[]` and re-run once a real admin existed. A documented-but-never-closed
  escape hatch is backlog 59 all over again — prefer a mechanism that closes itself.
- **Touch points.** `packages/installation-zerops/src/`, `packages/cli/`, and whatever moves out of
  `packages/installation-cloudflare/src/{scaffold,environment,gh,prompt,log}.ts` to be shared.

## Out of scope (explicit)

- **A private Git source** — backlog 47, blocked on a one-time interactive GitHub↔Zerops OAuth link
  the operator performs. Unrelated to installing the platform: the namespace proxy builds from a
  pinned tag of the public repository and needs no credential (ADR-0025).
- **The example app's light-tier descriptor** — backlog 60. It is an APP deploy, not an installation
  deploy.
- **The production two-project topology and custom domains** — backlog 05.

## Decisions

1. **On Zerops, `platform deploy` owns the deploy ORDER; on Cloudflare it stays in the scaffolded
   pipeline.** The two providers therefore have a differently-wide `deploy`, deliberately. ADR-0003
   gives Zerops no runner, so there is no per-package config directory to `cd` into and run an app
   deploy from — a Zerops deploy is `triggerPipeline` against a service id with a setup name. And the
   proxy manifest must be regenerated and applied in the same run as the code it describes, which is
   cross-service state that no single pipeline step owns cleanly. Backlog 61's "the contract owning
   the order" is superseded by
   [ADR-0027](../decisions/0027-platform-deploy-is-as-wide-as-the-provider-needs.md), which records
   this and the two alternatives it rejects.
2. **`init` and `deploy` stay separate, and the split is the one Cloudflare already ships**
   (`installation-cloudflare/src/init.ts` header): `init` is interactive, one-time and laptop-side —
   collect credentials, create the GitHub App, scaffold the sidecar repository, write the Environment,
   trigger. `deploy` is unattended and runs in the operator's CI. Not one idempotent command; both are
   idempotent, but they run in different places for different reasons.
3. **The live acceptance runs through the operator's pipeline, not from a laptop.** Backlog 61's
   acceptance is a live deploy, and the honest way to perform it is the way an operator would — so
   backlog 62 is pulled INTO this sprint as WU4 rather than deferred. Running `platform deploy` from a
   developer's machine would verify the command while leaving the thing it exists to be called by
   untested, and the root `CLAUDE.md` forbids deploying from localhost besides.
4. **`platform init --provider=zerops` does the whole job, but confirms before every outward-facing
   step.** It mirrors what `installation-cloudflare` already ships — create the repository, push the
   scaffold, write the GitHub Environment including secret VALUES over `gh` stdin, trigger the workflow
   — and asks first each time it reaches outside the operator's disk. Full automation, never silent.
   The `confirm` prompt this needs shipped in `installation-cloudflare/src/prompt.ts`; WU4 moved it to
   `@fabrika/installation-init`, which is where both inits now read it from.
5. **The sidecar repository is `contember/fabrika-zerops-test`**, following the
   `contember/vozka-platform-mangoweb` precedent, named so its relation to the `fabrika-test`
   installation is obvious.

## Sequencing

|                               | depends on | can run alongside |
| ----------------------------- | ---------- | ----------------- |
| WU1 (manifest generator)      | —          | WU3               |
| WU3 (fail-closed environment) | —          | WU1               |
| WU2 (the deploy command)      | WU1, WU3   | —                 |
| WU4 (init + the sidecar)      | WU2        | —                 |
| Live acceptance               | WU4        | —                 |

WU1 first: WU2 cannot write a manifest nothing generates, and WU1 is the piece with a witness that
does not need a live account. WU4 last of the code: it generates a workflow that calls WU2's CLI
surface, so that surface has to exist and be settled first.

## Run log

**WU1 — done.** The generator is `packages/installation-zerops/zerops/proxy-manifest.ts`, rendered into
the committed `zerops/generated/platform-proxy-manifest.ts` by `render.ts` (so CI's existing `gen:check`
step is the drift witness); `localPlatformProxyManifest` calls it. Three findings worth carrying:

- **`iam-local` → `iam`.** The id is inert for an app whose every rule is `public`: gate matching
  returns `allow` on the first rule with no token and no IAM call, so it never becomes a token audience
  and never reaches a login bounce; the `?app=` pin and the manifest lookup are both generated from the
  same list; and `exchangeAuthCode` binds a code to its issuing app (`packages/iam/src/handoff.ts:103`),
  while no code can be issued for IAM at all because it has no registered return origin. **The live
  installation's manifest therefore changes on its next deploy.**
- **A `ProxyManifest` cannot carry the committed half alone** — `parseProxyManifest` refuses an app with
  no hosts — so the artifact is a distinct template type. `resolvePlatformProxyManifest` binds hosts +
  scheme and returns the result THROUGH `parseProxyManifest`, so nothing can emit a manifest the proxy
  would reject.
- **The listener→app assignment is now committed data.** On the subdomain path a port IS a hostname
  (`proxy-292c-8080…`), so the template carries `port` per app: 8080 IAM, 8082 console, 8083 Operations,
  with 8084-8086 left as the application slots `setups.ts` describes. WU2 resolves hosts from these.
- **`installation-cloudflare` needed nothing.** Backlog 58 lists it as a touch point, but Cloudflare has
  no shared manifest — each service's proxy Worker bakes its own single-app one from `fabrika.config.ts`
  (`packages/local-stack/__tests__/proxy-gates.test.ts` already pins that side). Nothing to generate.

**Verified against the live account (2026-08-06).** The generated template, resolved with
`fabrika-test`'s hosts, reproduces the live `FABRIKA_PROXY_MANIFEST_JSON` app for app — `vozka` and
`operations` identical in hosts, upstream, scheme AND gates; `iam-local` differs only in the id.

⚠ **WU2 must MERGE, not replace.** The live manifest carries a fourth app, `notes` →
`notesapi:3000` on 8084: on the light tier an application shares the project and therefore the platform
proxy's one manifest. A `platform deploy` that writes the platform template alone deletes every app
entry and takes the deployed applications offline. The platform generator deliberately emits only the
three platform apps; composing them with the app entries is the deploy command's job.

### WU3 — the refusal (2026-08-06)

**The signal is the service's own PUBLIC ORIGIN**, stated by the composition root and enforced by
`readEnvironmentName` in `@fabrika/auth-core`. Rejected alternatives, both for the same reason — one
of them cannot be checked and the other does not exist:

- A Zerops platform variable. The `ZEROPS_` prefix really is reserved (`reference/zerops-platform.md:202`,
  F9 in the 08-03 archive), so any such key IS platform-written — but nothing in this repository verifies
  that a RUNTIME container holds one. Only the env API's refusal to accept the prefix is verified. Built
  on that, the refusal would be inert on the platform it is for, and settling it needs a live read.
  **Cheap for WU2 to settle**: dump the key NAMES (never values) a running container sees.
- A Cloudflare witness. workerd is the runtime in `wrangler dev` and in production alike; nothing at
  boot distinguishes them. A one-cloud signal would leave the Cloudflare half unprovable.

The origin is not a label: it is the `iss` of every token, the host a `__Host-` cookie belongs to, and
the address a browser is returned to — it cannot be wrong quietly, which `ENVIRONMENT` demonstrably
could. Loopback is RFC 6761 `localhost`/`*.localhost` plus `127.0.0.0/8` and `::1`, which is what every
local composition here serves.

**Ordering constraint for WU2:** write `ENVIRONMENT` on every service BEFORE deploying code carrying
this refusal. `control` on `fabrika-test` currently pairs `local` with a public host, so it would fail
its readiness check on the next deploy — loudly, which is the point, but it must not be a surprise.

Left for WU2 (operational, not code): writing the environment name on every service, and deleting the
inert `LOCAL_DEV_LOGIN` key from the live IAM.

### WU2 — the deploy command (2026-08-06, `eb103f9`)

`fabrika platform deploy --provider=zerops` now owns the sequence ADR-0027 gave it: resolve services,
write every environment, deploy IAM → Operations → proxy → control waiting for each, reconcile the
console's schema, ensure the public entry point. The surface is the `usage` string in
`packages/installation-zerops/src/index.ts` — WU4's generated workflow is written against it, so it is
a contract, not help text.

- **The console's `AppSchema` needed WU1's treatment too.** `controlSchema` lives in the private
  `@fabrika/control`, so it is rendered into `zerops/generated/platform-console-schema.ts` by a
  dev-time script and reaches a deployed installation as DATA. `gen:check` now witnesses both artifacts.
- **The merge is what makes WU1's rename safe.** An entry standing on a platform host is superseded
  with a warning, and `iam-local` → `iam` is exactly that case: carrying both would produce a document
  `parseProxyManifest` rejects. Entries the platform does not own are copied byte-for-byte.
- **`--dry-run` against the live account (2026-08-06).** The derivation reproduces the hand-placed
  installation: every return origin already matches byte for byte, and only `ENVIRONMENT` on three
  services and the manifest differ. That is the whole delta between a hand-built installation and a
  generated one, and it is the WU3 ordering constraint showing up exactly where it was predicted.
- **Still not done, and not code:** deleting the inert `LOCAL_DEV_LOGIN` key from the live IAM. The
  deploy neither writes nor removes it. It is harmless only because WU3's refusal will stop `local`
  from surviving on a public origin at all.

### WU4 — init and the sidecar repository (2026-08-06, `a820ac9`) · consumes backlog 62

`fabrika platform init --provider=zerops <installation>` generates and maintains the operator's sidecar
repository. The workflow calls ONE step because ADR-0027 put the order inside the command, pins a
published tag, restricts its push trigger to `['fabrika.ref', '.github/workflows/platform.yml']`, and
carries a `dry_run` input for the first pass after an Environment edit.

- **A new PUBLIC package, `@fabrika/installation-init`** — the hidden secret prompt, the shell rules
  that never log a child env, the `gh` wrapper, the GitHub Environment write, and a generic sidecar
  scaffold, moved out of `installation-cloudflare` with `git mv`. ~600 lines whose whole point is that
  no helper accepts a secret VALUE; two copies of that invariant is what the invariant exists to
  prevent. The FLOW stays per-provider (ADR-0027) — Zerops has no GitHub App, no runner image, no vault
  key. `EXPECTED_PUBLIC_PACKAGES` in `scripts/release.ts` went 21 → 22.
- **The bootstrap-admin hatch is closed by not existing here.** `platform deploy` on Zerops writes no
  credential and no admission list, so `init` has nothing to seed and the operator has nothing to reset
  to `[]` later; a test asserts no Environment key contains `BOOTSTRAP`. **The Cloudflare path still has
  the open hatch** the sprint warned about — `installation-cloudflare/src/init.ts:522-524` prints reset
  instructions and trusts the operator to follow them. → backlog
  [64](../backlog/64-close-the-bootstrap-admission-hatch-automatically.md).
- **A Zerops build source names a REPOSITORY, not a revision.** So `fabrika.ref` pins what the pipeline
  DOES — the order, the composed manifest, the gates, the console schema, every written variable — but
  not the revision Zerops BUILDS. The generated README says so rather than implying otherwise.
  **ADR-0025:72 claims `proxyBuildFromGit` "names a tag"; `zerops/topology.ts:126` sets a bare URL.**
  That is real drift in a decision, not a not-yet-built gap. → backlog
  [65](../backlog/65-pin-a-zerops-build-to-a-revision.md).
- **Scope is an installation that ALREADY EXISTS.** A fresh account still needs the hand bring-up: a
  proxy that has never deployed publishes no HTTP ports, so no subdomain exists to derive hosts from
  while the manifest must be written first. Backlog 62's acceptance named a fresh account and this does
  not meet it — 62 is rewritten rather than deleted.

**Verification (`a820ac9`).** 2021 pass / 9 skip / 0 fail against `postgres:17`; typecheck, lint,
format, `gen:check` and `release:validate --tag` all 0 over 22 public packages.

### Live acceptance — blocked (2026-08-07)

Not started. Four things stand in front of it, and only the first is ours to fix in code:

1. **No tag exists.** `git tag -l` is empty. The generated workflow accepts only `v[0-9]*`
   (`templates/platform.yml:64`) and `.github/workflows/release.yml` triggers on `v*` — the first
   pattern is a SUBSET of the second, so no tag name can run the sidecar while missing the release
   pipeline. Settled 2026-08-07: bootstrap npm first (backlog 25), then tag.
2. **Credentials are the operator's** — `FABRIKA_ZEROPS_ACCESS_TOKEN` (an integration token, never the
   personal one `zops` holds) and the `px_` `FABRIKA_IAM_PROVISIONING_KEY`. Neither is in the repo.
3. **`init` is outward-facing** — it creates `contember/fabrika-zerops-test`, pushes, writes the
   Environment and triggers. Run it with a human watching each confirmation.
4. **Run `dry_run` first.** It is the only cheap witness for the two sequences that have never
   executed: the environment-write-before-deploy ordering against a live `control` that still pairs
   `local` with a public host, and the manifest merge, whose failure mode is taking a deployed
   application offline.

Backlog [47](../backlog/47-give-the-zerops-path-a-private-git-source.md) does **not** block this: the
platform services build from the public repository, and the OAuth link it needs is for a private APP.
