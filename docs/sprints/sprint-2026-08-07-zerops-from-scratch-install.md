# Sprint — a Zerops installation from an empty project (2026-08-07)

**Goal.** The operator creates an empty Zerops project by hand. Everything after that is `fabrika`:
provision the topology, generate and place every secret, bring the installation up, and hand the
operator the one key `platform init` will ask for. Authentication is **password only**.

**Theme.** [Backlog 62](../backlog/62-generate-the-operators-sidecar-install-repository.md) named a
fresh account in its acceptance and the shipped `init`/`deploy` pair deliberately does not meet it —
`packages/installation-zerops/CLAUDE.md` states outright that neither command creates an
installation. That gap is the last hand ritual in the Zerops path, and it is the one that has never
been tested by anything. Closing it also gives
[backlog 63](../backlog/63-a-one-click-install-from-the-public-repository.md) its missing half.

The predecessor sprint's live acceptance moves here: proving the sidecar against a **fresh** project
is strictly better than proving it against `fabrika-test`, which hosts a live `notes` application.

## Refs re-verified at HEAD (2026-08-07)

- ✔ **The proxy's HTTP ports come from the deployed app version, not the import.**
  `PROXY_PUBLIC_PORTS = [8080, 8082, 8083, 8084, 8085, 8086]` (`zerops/setups.ts:380`) reaches
  `run.ports` (`:427`); the provisioning document declares no ports at all
  (`zerops/generated/platform-light.provision.zerops-import.yaml`). This is what makes a two-pass
  bring-up possible.
- ✔ **`{"apps":[]}` is a legal manifest.** `parseProxyManifest` requires only that `apps` is an array
  (`packages/proxy-contract/src/index.ts:37-40`); the host-less refusal is per app (`:90`), so it
  never fires on an empty list. `setups.ts:409` already says an empty list emits deny/404 routes only.
- ✔ **The proxy passes readiness independently of its auth binary.** `start.sh:12-19` runs
  `fabrika-proxy` in a background restart loop and `exec`s Caddy; `buildCaddyConfig` emits a separate
  `health` server on `:8081` (`packages/proxy/src/caddy.ts:243-250`) which is the readiness gate
  (`setups.ts:421`). ⚠ Reasoned from code — **never observed live**. WU1's first act is to observe it.
- ✔ **`zeropsSubdomain` is a NAME, not a state** — populated on a service whose subdomain was never
  enabled (`docs/reference/zerops-platform.md:425-426`), which is what lets hosts be derived one step
  before `enableSubdomainAccess`.
- ✔ **Password-only needs no email.** `packages/iam/src/admin/handlers.ts:598-606` returns
  `{ delivery: 'manual', url }` when `services.email === null`, which is the default
  (`iam/src/node/runtime.ts:73`). Pinned by `iam/src/__tests__/admin-password-rpc.test.ts:141-143`.
  Email is required only for self-service `/auth/forgot-password` (`iam/src/auth/routes.ts:644`).
- ✔ **The provisioning key reaches all of `/admin/rpc`** and is checked before any DB lookup
  (`iam/src/auth.ts:99-106`, `:108`), so it works on a virgin database; the principal row exists
  (`iam/migrations-postgres/0002_provisioning_principal.sql`).
- ⚠ **On Bun the IAM names are UNPREFIXED** — `IAM_BOOTSTRAP_ADMINS`, `ISSUER`, `HUMAN_*`, `OIDC_*`
  (`iam/src/node/runtime.ts:61,70-72,94-96`). The `FABRIKA_IAM_*` spellings are the Cloudflare deploy
  variables translated by `packages/iam/fabrika.config.ts:142-145`. Writing a prefixed name on a
  Zerops service is a **silent no-op**.
- ⚠ **IAM's `/healthz` is a static 200** (`iam/src/app.ts:60`) and never touches the signer, so a
  missing `FABRIKA_IAM_SIGNING_KEYS` yields an ACTIVE deploy whose every mint throws
  (`iam/src/signing.ts:213-216`). **Verification must mint a token, not probe readiness.**
- ⚠ **`ZeropsApi` has no `getProcess`**, so nothing can poll an import's processes
  (`packages/provider-zerops/src/api.ts:71-84`). Whether a service is writable the instant
  `importServices` returns is unrecorded; `zerops-platform.md:198` says only "from the moment the
  service exists".
- ⚠ **No integration-token call exists.** `setups.ts:246-247` names
  `POST /client/{id}/integration-token` as the right source for control's token; it is absent from
  `ZeropsApi`.
- ✔ **`importServices` exists** — `POST /project/{id}/service-stack/import`
  (`provider-zerops/src/api.ts:218-227`), which is the call for an operator-created project.
  `importProject` creates a project and must NOT be used here: Zerops permits duplicate project names
  (`installation-zerops/src/deploy.ts:131-133`), so a `project:`-bearing document risks a second one.
- ✔ **A services-only compile already exists** for app namespaces (`provider-zerops/src/namespace.ts:416`);
  `compileImport` branches on `target.project === undefined` (`compile.ts:248-250`).
- ✔ **`deployPlatform` is reusable wholesale for pass 2** — resolve, read-compare-write env, ordered
  deploy, manifest merge, console reconcile, subdomain ensure (`installation-zerops/src/deploy.ts`).

## Work units

### WU1 — Observe the pass-1 proxy live (effort XS) · de-risks everything else

- **Problem.** The whole two-pass design rests on one unobserved claim: a proxy whose `fabrika-proxy`
  binary cannot boot still reaches ACTIVE and publishes its ports. If that is false, the design
  changes shape and every later WU is built on sand.
- **Scope.** On a throwaway project, provision `proxy` alone, write `FABRIKA_PROXY_MANIFEST_JSON =
  {"apps":[]}` plus a syntactically valid `FABRIKA_IAM_URL`/`FABRIKA_IAM_KEY`, trigger the pipeline,
  and record what happens.
- **Acceptance.** A recorded observation in `docs/reference/zerops-platform.md`: whether the version
  reaches ACTIVE, whether `zeropsSubdomain` populates, and **how long after** the deploy it does
  (open question 4 — pass 1 may need a poll).
- **Touch points.** `docs/reference/zerops-platform.md`.

### WU2 — A services-only platform provisioning artifact (effort S)

- **Problem.** Every generated platform document carries a `project:` block
  (`zerops/topology.ts:300-353`), but the operator creates the project, so the bootstrap must import
  services into an existing one. `envIsolation` is settable at project creation only
  (`compile.ts:156-158`), so a `project:` block against an existing project could not take effect
  even if the endpoint tolerated it — and whether it does is unverified.
- **Scope.** A second `ZeropsSourceTarget` sharing the same `services` function with `project`
  omitted, compiled through `compileProvisioningYaml` and `compileImportYaml`, exactly mirroring
  `namespace.ts:416`. Committed under `zerops/generated/` and covered by `gen:check`.
- **Acceptance.** `platform plan` validates the new artifacts; a test pins that the services-only
  document has no `project:` key and that every service still carries `envIsolation: service`
  (ADR-0004).
- **Also fix.** `zerops/artifacts.ts:79` labels the steady artifact
  "`POST /project/{projectId}/service-stack/import`" while that file contains a `project:` block.

### WU3 — `fabrika platform install --provider=zerops` (effort L) · the command

- **Problem.** Nothing generates a credential for a Zerops installation and nothing writes one to a
  Zerops service. `platform deploy` must not (its invariant is literal), and `platform init` must not
  (ditto). So this is a third command.
- **Scope.** Widen `InstallationCommand` (`packages/installation-contract/src/index.ts:1`) — Cloudflare
  simply does not declare it. The command, in order:
  1. Resolve the operator's project; **check `mode` against the selected tier** (`api.ts:151-152`)
     and refuse a mismatch, since `corePackage` is upgrade-only and partly destructive.
  2. Import the WU2 services-only provisioning document. Detect services that already exist and skip
     rather than re-applying: re-applying `startWithoutCode` to a service carrying code activates an
     EMPTY app version and demotes the running one to `BACKUP` (`zerops-platform.md:277`).
  3. Generate the six secrets — IAM signing keys (ES256 P-256 JWK array), RPC key, proxy key,
     provisioning key, Operations sync key (all `px_`/base64url, 32 bytes), and the vault KEK
     (**32 raw bytes, base64**, not base64url). Re-roll any base64url value starting with `-` or `_`
     (`local-stack/src/prepare.ts:20-36`).
  4. Pass 1: write the proxy's three variables, trigger, wait for ACTIVE, read `zeropsSubdomain`,
     derive the three hosts.
  5. Write every remaining variable on all four services — the platform-reference set
     (`${db_connectionString}` &c.), the derived set (issuer, origins, domains), and the generated set.
  6. Hand off to `deployPlatform` for pass 2. **Do not reimplement the order** — it is a security
     property (ADR-0027) pinned by `zerops/__tests__/deploy-order.test.ts`.
  7. Print the provisioning key ONCE, the way Cloudflare prints the vault KEK
     (`installation-cloudflare/src/init.ts:345-348`), and name what `platform init` will ask for.
- **Scope guards.** Never write a key the service declares in its own `zerops.yaml` — the API refuses
  it (`api.ts:781-786`). Generated secrets are written blind and never compared. Confirm before every
  outward step, matching the predecessor sprint's decision 4.
- **Acceptance.** Against a fresh project: the installation comes up, and **a token mints** — not
  merely a green readiness probe. Handing off to WU5 is WU5's acceptance, not this one's.
- **Touch points.** `packages/installation-contract/`, `packages/installation-zerops/src/`,
  `packages/cli/`, `packages/provider-zerops/src/api.ts`.

### WU4 — The first administrator (effort M)

- **Problem.** After WU3 the installation runs and nobody can sign in. The path exists but no command
  walks it, and `IAM_BOOTSTRAP_ADMINS` is the never-closing hatch
  [64](../backlog/64-close-the-bootstrap-admission-hatch-automatically.md) was filed for.
- **Scope.** Invite a principal and issue an enrollment URL through `/admin/rpc` with the provisioning
  key (`principals.invite`, then `passwords.issueEnrollment`), print the URL, and — see decision 2 —
  write a real grant rather than seeding an admission list.
- **Acceptance.** A human opens the printed URL in a browser, sets a password, and reaches the console
  as an administrator, with **no `IAM_BOOTSTRAP_ADMINS` value set anywhere**.

### WU5 — Run `platform init` and let CI deploy (effort S) · the one thing that has never happened

- **Problem.** `fabrika platform init --provider=zerops` shipped on 2026-08-06 (`a820ac9`) and **has
  never been executed once, against any account.** Everything about it — the repository creation, the
  scaffold push, the GitHub Environment write, the workflow dispatch, and the CI `platform deploy` it
  triggers — is verified only by unit tests against fake APIs. It is the last untested link, and it is
  the reason this sprint and its predecessor exist. It was previously buried as a clause in WU3's
  acceptance and as an undefined row in the sequencing table; that was a planning defect.
- **This depends on nothing — including the operator.** `init` is shipped code, and **both secrets it
  writes already live on the installation**, verified 2026-08-08 by reading the service environments
  through `@fabrika/provider-zerops` (names and lengths only, never values):
  `FABRIKA_IAM_PROVISIONING_KEY` on `iam` and `control`, and `FABRIKA_ZEROPS_ACCESS_TOKEN` on
  `control`. That is exactly what the invariant means by "both Environment secrets already belong to
  the installation" — so `init` sources them from the installation, and asking a human to paste a
  secret is the wrong shape: it puts the value somewhere it was not before.
  - **Against `fabrika-test` this is runnable today, with no input from anyone.** The tag `v0.0.2`
    exists and `--dry-run` reproduces the project. The only cost is that a real deploy mutates a
    project hosting a live application — a decision, not a blocker.
  - **Against a fresh installation it waits for WU3**, which generates the same two values instead of
    reading them.
- **Verify first.** Run the generated workflow with its `dry_run` input before any real run. It is the
  only cheap witness for the two sequences that have never executed: the `ENVIRONMENT`-write-before-
  deploy ordering and the proxy manifest merge, whose failure mode is taking a deployed application
  offline. That ordering is **not hypothetical**: `ENVIRONMENT` on `fabrika-test`'s `control` and
  `operations` is still five characters long — `local` — on services answering public hosts, so the
  next real deploy is also the first exercise of WU3-the-refusal against a live installation.
- **Scope.** Read both secrets from the installation into the environment `init` reads. Run `init`,
  confirming each outward step. Let it create the sidecar repository, write the GitHub Environment and
  dispatch. Then bump `fabrika.ref` and prove a version roll.
- **Acceptance, in order:**
  1. The sidecar repository exists and carries exactly the four scaffolded files.
  2. Its workflow runs green in **`dry_run`** and reports a plan that matches the local `--dry-run`.
  3. It runs green for real, and the installation serves the version the pinned tag names.
  4. Bumping `fabrika.ref` and pushing rolls the installation forward — the whole point of the file.
  5. A re-run with no change is a no-op: every write is read-compare-write.
- **Touch points.** None in this repository if it passes. Anything it forces is a finding, and findings
  from this WU are the most valuable thing in the sprint — nothing else has touched this path.

## Out of scope (explicit)

- **A private Git source** — [47](../backlog/47-give-the-zerops-path-a-private-git-source.md). The
  four services build from a public `buildFromGit` URL, so `--from-git` is effectively mandatory here.
- **Pinning what Zerops builds** — [65](../backlog/65-pin-a-zerops-build-to-a-revision.md). A build
  source names a repository, not a revision; the bootstrap cannot fix that.
- **Closing the hatch on the Cloudflare path** — [64](../backlog/64-close-the-bootstrap-admission-hatch-automatically.md).
  WU4 avoids opening one here; it does not fix Cloudflare.
- **The standard two-project topology and custom domains** — [05](../backlog/05-bring-up-on-a-real-zerops-account.md).
- **OIDC.** Password only, by decision.

## Decisions

1. **A third command, not a flag.** `platform deploy`'s "writes no credential / an unknown flag is an
   error" and `platform init`'s "generates no credential" are both literal invariants in
   `packages/installation-zerops/CLAUDE.md`. A bootstrap writes eight secrets and generates six, so it
   fits inside neither. It runs before `init` and hands `init` the key it generated.
2. **No bootstrap admission list.** WU4 issues a real grant instead of seeding `IAM_BOOTSTRAP_ADMINS`.
   The Zerops path has no hatch today precisely because nothing seeds one, and reproducing the
   Cloudflare hatch here would file backlog 64 against ourselves on the day we wrote the code.
3. **Verification mints a token.** IAM's `/healthz` is a static 200 that never touches the signer, so
   readiness proves nothing about the signing key. Every acceptance in this sprint is an exercised
   behaviour, per the standing rule that a green deploy means only that Zerops accepted it.

## Open decisions — needed before WU3 lands

- **Where control's integration token comes from.** `setups.ts:246-247` names
  `POST /client/{id}/integration-token`, which is not on `ZeropsApi`. Either the bootstrap mints a
  correctly-scoped token (client `NO_ACCESS`, per-project `ADMIN`) — adding that call — or it prompts
  the operator for a second token. Handing control the same token the bootstrap authenticated with is
  **not** an option when that token is personal.
- **`envIsolation` on a hand-created project** is settable at creation only and is not readable back
  (`zerops-platform.md:164-168`). The per-service `envIsolation: service` in the import mitigates it,
  but the bootstrap cannot verify the project-level value — so the operator instructions must say it.

## Sequencing

|                                 | depends on          | can run alongside |
| ------------------------------- | ------------------- | ----------------- |
| WU1 (observe pass-1 proxy)      | —                   | WU2, WU5          |
| WU2 (services-only artifact)    | —                   | WU1, WU5          |
| WU3 (the install command)       | WU1, WU2            | WU5†              |
| WU4 (first administrator)       | WU3                 | —                 |
| WU5 (run `init`, let CI deploy) | **nothing in code** | WU1–WU3           |

WU1 first because it is cheap and the whole design rests on it — done.

† **WU5's placement is a decision, not a dependency.** It needs no code from this sprint; it needs a
target and two credentials. Run it against `fabrika-test` and it can start immediately, at the cost of
mutating a project that hosts a live application. Run it against a fresh installation and it becomes
the last step, after WU3. Either way it must not be left implicit again: it is the only work here that
tests code nothing has ever executed.

## Run log

**WU1 — done (2026-08-08).** Observed on a throwaway project `fabrika-wu1-probe`, since deleted. The
measurements are in
[`reference/zerops-platform.md`](../reference/zerops-platform.md#verified-live-2026-08-08-account-prg1-throwaway-project-fabrika-wu1-probe--a-proxy-before-it-fronts-anything).
The design holds:

- **A proxy carrying `{"apps":[]}` is a complete service.** Built ~190 s, deployed ~60 s, `ACTIVE`, and
  answered **404** on public listener 8080 — `setups.ts:409`'s claim, now observed rather than reasoned.
- **No poll is needed after pass 1.** The six per-port subdomain lines were present in the same 10 s
  poll that first saw `ACTIVE`. Open question 4 is closed: there is no measurable lag.
- **`putServiceEnv` works on a never-deployed service**, immediately after the import's processes
  report `FINISHED`. Open question 2 is closed for the light path.
- **The two-pass shape is still required, and for a sharper reason than expected.** Before a deploy
  `zeropsSubdomain` is present but holds ONE line with **no port segment**
  (`https://proxy-2b16.prg1.zerops.app`), so `parseZeropsSubdomains` finds no `-<digits>` and
  `derivePlatformHosts` throws — correctly. The `<4 chars>` segment is nonetheless **unchanged** across
  the deploy, so the per-port hosts were predictable in hindsight. **Do not act on that**: it is one
  observation of one format, and composing a hostname is what `hosts.ts:83-88` deliberately refuses.
  Recorded as a possible future one-pass optimisation, not a plan.

Two things this did NOT establish, stated so nobody reads more into it than it says:

- Whether a proxy whose auth binary cannot boot still reaches `ACTIVE`. The run wrote a legal
  `FABRIKA_IAM_URL`/`FABRIKA_IAM_KEY` pair, as a bring-up will, so the case does not arise. The
  survey's reasoning from `start.sh` and the `:8081` health server remains untested.
- Anything about the other five services. Only `proxy` was provisioned.

**Tooling note.** `zops env list` and `zops env set` fail with `Service stack not found` on service ids
that `zops service list` returned one line earlier, on two separate projects; `zops env show` works.
The probe used `@fabrika/provider-zerops`'s own client instead, which is the code path the bootstrap
will use anyway. Not investigated further — it is not our CLI.
