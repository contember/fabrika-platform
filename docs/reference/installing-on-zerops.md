# Installing fabrika on Zerops

The operator's procedure from an empty Zerops account to a serving application. It gives the order,
the prerequisites, and how to check each step. It does not repeat the flags: every command prints its
full surface, and that text is authoritative.

```bash
fabrika platform --provider=zerops --help
fabrika control --help
```

The reasons behind the shape of this procedure are in
[ADR-0025](../decisions/0025-the-operator-installs-the-platform-fabrika-deploys-apps.md) (the operator
owns the pipeline) and [ADR-0027](../decisions/0027-platform-deploy-is-as-wide-as-the-provider-needs.md)
(one `deploy` step owns the order).

## Overview

| Step | Command                                                                          | Runs        | Result                                                     |
| ---- | -------------------------------------------------------------------------------- | ----------- | ---------------------------------------------------------- |
| 1    | `fabrika platform install`                                                       | once        | A running installation, and the provisioning key           |
| 2    | `fabrika platform admin`                                                         | once        | The first administrator's enrollment URL                   |
| 3    | `fabrika platform init`                                                          | re-runnable | The sidecar repository whose pipeline deploys the platform |
| 4    | `fabrika control key issue`                                                      | per client  | A machine key for `fabrika control`                        |
| 5    | `fabrika namespace create`, `fabrika control register`, `fabrika control deploy` | per app     | A serving application                                      |
| 6    | `fabrika platform upgrade`                                                       | per release | The installation on a newer fabrika tag                    |

Steps 1–3 run on the operator's machine. `install` creates an installation; `init` and `deploy` refuse
to. Step 2 needs only step 1, so it may run before or after step 3.

## Prerequisites

- **[Bun](https://bun.sh) ≥ 1.3.** The CLI is TypeScript and runs on Bun.
- **The `fabrika` command.** `bun add --global @fabrika/cli @fabrika/provider-zerops`, then `fabrika --help`. The CLI
  loads the provider package and does not install it.
- **`git` and the [GitHub CLI](https://cli.github.com) (`gh`), signed in** with permission to create a
  repository and write Environment secrets in the organization that will own the sidecar. `init` and
  `upgrade` use the operator's own `gh` login and hold no GitHub credential themselves.
- **A Zerops personal access token**, generated in the Zerops GUI. Only `install` uses it. The
  installation never stores it: `install` mints a separate integration token (client role `NO_ACCESS`,
  `ADMIN` on the one project) for the control plane.
- **The Zerops client id.** It is the client named in the `clientUserList` entry of `GET /user/info`:

  ```bash
  curl -s -H "Authorization: Bearer $FABRIKA_ZEROPS_ACCESS_TOKEN" \
    https://api.app-prg1.zerops.io/api/rest/public/user/info
  ```

  Set `FABRIKA_ZEROPS_API_URL` for every command when the account is not on the default region.
- **A published fabrika tag** to pin, for example `v0.2.0`. A branch is refused.

Credentials are read from the environment only. No command takes one as a flag.

## 1. Install the platform

```bash
export FABRIKA_ZEROPS_ACCESS_TOKEN=<personal access token>
fabrika platform install --provider=zerops --create-project --client-id=<id> --env=<name>
```

`--create-project` creates the project with the two settings Zerops accepts at creation only: core
package `LIGHT` and `envIsolation: service`. Its id is printed before the wait, so an interrupted run
resumes with `--project-id=<id>`. To install into a project you created yourself, pass `--project-id`
instead; that project must be empty and carry both settings already.

The command confirms before every step that leaves the machine. A stdin that is not a terminal is
refused unless `--yes` is passed. It then imports the services without code, generates six secrets,
mints the integration token, builds the proxy once to learn the three public hosts, writes every
variable, and runs the full ordered deploy.

Every secret is written to the environment of the Zerops service that uses it. Nothing is written to
disk, and the pipeline created in step 3 never sees those values.

**Capture the provisioning key.** The run ends with a box containing `FABRIKA_IAM_PROVISIONING_KEY=px_…`.
The CLI prints it once and keeps no copy. The only other copies are the `iam` and `control` services'
environments, readable by anyone with access to the Zerops project. Steps 2, 3 and 4 need it.

**Check.** The output lists `✓ iam <host>`, the console origin, and a ready-to-run `platform admin`
command. All four runtime services read `ACTIVE` in the Zerops GUI.

`install` refuses a project that already holds an installation's generated secrets, and refuses a
partial set of services. Update an existing installation through the sidecar pipeline (step 3), never
with a second `install`.

If bootstrap stops after services or secrets were created but before full
configuration, retrying `install` is refused. `init` and `deploy` do not complete
that partial bootstrap. After full configuration, a pass-two deployment failure
can be retried with `platform deploy` using the printed project/environment and
the existing credentials; do not generate replacement secrets.

## 2. Admit the first administrator

Nobody can sign in until this runs. Authentication is password only after a fresh install.

```bash
export FABRIKA_IAM_PROVISIONING_KEY=<the key from step 1>
fabrika platform admin --provider=zerops --email=<address> --iam-host=<iam host from step 1>
```

It invites the principal, grants the cross-app `admin` role, and prints one password enrollment URL.
The URL is a credential: it is printed once and stored nowhere.

**Check.** Open the URL, set a password, and sign in at the console origin. Delivery, Access and
Operations all load. A re-run changes nothing and reports the outstanding enrollment; `--reissue`
replaces one that expired unopened.

## 3. Create the sidecar repository

The sidecar is a repository the operator owns. Its GitHub pipeline calls `fabrika platform deploy`, and
its `fabrika.ref` pins the fabrika tag the pipeline runs.

```bash
export FABRIKA_IAM_PROVISIONING_KEY=<the key from step 1>
export FABRIKA_ZEROPS_ACCESS_TOKEN=<the integration token from the control service's environment>
fabrika platform init --provider=zerops <installation> --tag=<tag> --project-id=<id>
```

`<installation>` names the GitHub Environment, the default repository
`contember/fabrika-zerops-<installation>`, and the local checkout directory. Pass
`--repo=<owner>/<name>` for a different repository. The local checkout is `./fabrika-zerops-<installation>`,
or `--checkout=<dir>`; `init` refuses a checkout inside another git repository, so run it from a
directory outside any repository (a home directory that is itself a dotfiles repository counts) or
pass `--checkout`. `platform upgrade` looks for the default directory; after a custom `--checkout`,
pass it the same path with `--sidecar=<dir>`.

`init` prompts for nothing. Every value is a flag or the environment variable beside it, flag first:
`--tag` (`FABRIKA_PLATFORM_TAG`, the published tag to pin), `--project-id` (`FABRIKA_ZEROPS_PROJECT_ID`),
`--env` (`FABRIKA_PLATFORM_ENVIRONMENT`, default `<installation>`), and, for custom domains, all three of
`--iam-host`, `--console-host` and `--operations-host`. A missing value is an error naming both. The two
secrets are environment only, and `init` generates neither:

| Secret                         | Where it comes from                                                                                                                            |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `FABRIKA_IAM_PROVISIONING_KEY` | The key `install` printed.                                                                                                                     |
| `FABRIKA_ZEROPS_ACCESS_TOKEN`  | The integration token `install` minted. Read it from the `control` service's environment in the Zerops GUI. Never use the personal token here. |

Both are sent to GitHub over `gh` stdin. `init` confirms before each outward step: reading the project,
creating or pushing the repository, writing the Environment, and triggering the first run. A stdin that
is not a terminal is refused unless `--yes` is passed. Declining stops there and prints the command
that repeats the run. A re-run is safe.

**Check.** The `platform` workflow run in the sidecar repository ends green. Its first run changes
little, because step 1 already deployed the same code.

`init` ends with a block that names the variables step 4 needs and, when it can read it, exports the
IAM origin.

## 4. Mint a machine key

`fabrika control` authenticates with a machine key. Minting one presents the IAM RPC key as transport
authentication and the provisioning key as the issuing credential.

```bash
export FABRIKA_IAM_RPC_URL=<IAM's public origin, https://…>
export FABRIKA_IAM_RPC_KEY=<from the iam or control service's environment>
export FABRIKA_IAM_PROVISIONING_KEY=<the key from step 1>
fabrika control key issue --label=<name> --permissions=app.manage,namespace.manage,deploy.trigger,deploy.read --expires-in=2592000
```

The permissions are control's actions: `app.manage`, `namespace.manage`, `deploy.trigger`,
`deploy.read`, `secret.manage`, `source.connection.manage`. Grant only what the client needs. IAM
refuses a wildcard and any action outside control's catalog.

Every key expires. `--expires-in` is required and is at most 2592000 seconds (30 days), so a long-lived
client mints a new key before the old one expires.

`FABRIKA_IAM_RPC_URL` is the public `https://` origin — the value `FABRIKA_IAM_ISSUER` holds on the
`control` service. The private `http://iam:3000` answers only inside the Zerops project.

For the remaining steps:

```bash
export FABRIKA_CONTROL_URL=<the console origin>
export FABRIKA_CONTROL_KEY=<the px_ key just issued>
```

**Check.** `fabrika control apps list` answers, with an empty list on a fresh installation.

## 5. Deploy the first application

The console covers this step too: **Namespaces** creates a placement, **Onboard an app** registers a
built manifest, and the app detail page deploys. The CLI sequence is the same procedures over the same
RPC contract ([ADR-0033](../decisions/0033-operate-the-control-plane-from-the-cli.md)).

1. **Connect a source, for a private repository.** In the console, open **Settings → Source** and
   create the organization's GitHub App. This is a browser flow only. A public repository needs no
   connection.
2. **Create a namespace.** A namespace is the Zerops project applications are placed in.

   ```bash
   fabrika control namespaces plan   --namespace=<id> --env=<name> --preset=cheap
   fabrika control namespaces create --namespace=<id> --env=<name> --preset=cheap
   fabrika control namespaces get    --namespace=<id>
   ```

   `create` returns while the state is `pending`; provisioning takes minutes. `get` reports the state
   and, once `ready`, the hosts the namespace serves and which are free. Presets and isolation are in
   [`deployment-namespaces.md`](deployment-namespaces.md).
3. **Build the manifest**, in the application's repository:

   ```bash
   fabrika app build --env=<name>
   ```

   It writes `fabrika.manifest.json`. [`examples/zerops-app`](../../examples/zerops-app/README.md) is a
   worked application.
4. **Register the application.**

   ```bash
   fabrika control register --provider=zerops --app=<id> --repo=<url> --env=<name> \
     --manifest=fabrika.manifest.json --namespace=<id> --domain=<a free host from step 2>
   ```

   `--domain` is required when the manifest publishes the application through the namespace proxy.
   `--installation-id=none` registers an anonymous public repository; omitting the flag resolves the
   installation from the organization's connected GitHub App. A changed manifest is applied later with
   `fabrika control apps environments put`, never with a second `register`.

   Steps 3 and 4 are also one command, run from the application's repository root:

   ```bash
   fabrika app register --app=<id> --repo=<url> --env=<name> --namespace=<id> --domain=<a free host from step 2>
   ```

   It compiles the manifest in memory exactly as `app build` does and sends the request `control register`
   sends for that file, so it takes the same options except `--manifest`. It writes no file. The control
   origin and `FABRIKA_CONTROL_KEY` come from the same places. A failure names its phase: a compile
   failure registered nothing, and a register failure left nothing on disk.
5. **Deploy.**

   ```bash
   fabrika control deploy --app=<id> --env=<name>
   fabrika control runs list --app=<id>
   fabrika control runs log --run=<id>
   ```

   The deploy fails when the `zerops.yaml` at the resolved commit differs from the registered manifest;
   rebuild and re-apply the manifest in that case.

**Check.** The run ends `succeeded` and the application answers on its domain, behind the sign-in the
proxy enforces.

## 6. Upgrade the installation

```bash
fabrika platform upgrade --provider=zerops --to=<tag> <installation>
```

It checks that the tag is published, writes it to `fabrika.ref` in the sidecar checkout, commits,
pushes, prints the workflow run URL, and watches the run. The push is the trigger. `--dry-run` reports
the roll without committing. A redeploy at the same tag is _Actions → platform → Run workflow_ in the
sidecar repository.

The tag selects the checkout the pipeline uploads, so it pins both what the pipeline does and the
code Zerops builds ([ADR-0045](../decisions/0045-upload-immutable-platform-and-namespace-proxy-sources.md)).
Existing namespaces keep their own proxy commit; the upgrade changes only the default for new ones.

## How install and deploy work

The internals behind steps 1, 3 and 6. The platform facts they rely on are in
[`zerops-platform.md`](zerops-platform.md).

### `fabrika platform install --provider=zerops`

The from-scratch bring-up: `packages/provider-zerops/src/installation/install.ts`. The operator either
creates an EMPTY project (core package `LIGHT`, `envIsolation: service` — a project-level setting
the platform accepts at creation only and never hands back, so nothing can verify it) and names it
with `--project-id`, or passes `--create-project` and this command creates it from the same compiled
declaration the services import comes from. A created project is polled to `ACTIVE` (`NEW` →
`CREATING` → `ACTIVE`, about 20 s live) before the first service import, because whether a service
import into a `CREATING` project succeeds has not been measured; its id is printed before the wait so
an interrupted run resumes with `--project-id`. The command is interactive and laptop-side,
confirming before every step that leaves the operator's disk, and it is the only command that
generates a credential for an installation. `platform admin` and `platform init` end with a pasteable
block for the first machine key: `export FABRIKA_IAM_RPC_URL=<IAM's PUBLIC origin>` (the value
`control` holds as `FABRIKA_IAM_ISSUER`), the NAMES of `FABRIKA_IAM_RPC_KEY` and
`FABRIKA_IAM_PROVISIONING_KEY` with the place each can be read from, and the `fabrika control key
issue` line — never a value. `http://iam:3000` answers only inside the project; `key issue` says so
when it cannot connect.

Its shape is decided by three [platform facts](zerops-platform.md):

- **Two passes, because the public hostnames come from a DEPLOY.** `zeropsSubdomain` names one host
  per deployed HTTP port and the proxy's ports come from its app version, not from the import — so
  pass 1 writes the legal empty manifest `{"apps":[]}` plus a syntactically valid IAM URL and key,
  builds the proxy alone, and reads the six lines back. Pass 2 writes everything else and hands the
  whole ordered sequence to `platform deploy`, which owns it (ADR-0027).
- **The import is skipped when the services already exist**, because re-applying a
  `startWithoutCode: true` document at a service carrying code activates an EMPTY app version and
  demotes the running one to `BACKUP`. A PARTIAL set is refused rather than completed: an import
  applies as one document and cannot skip the services that are already there. A service still reading
  `NEW` is refused too — see the [platform facts](zerops-platform.md).
- **Every process the import returns is waited on before anything is read or written**, because a
  service holds no environment at all until it leaves `NEW`.
- **Generated secrets are written blind.** They are never read back for comparison, so the command
  cannot tell a correct value from a stale one — which is why it refuses a project that already carries
  those KEYS instead of writing over them. A second bring-up would roll a new vault KEK (unrecoverable)
  and new signing keys (every live token invalid).

It places six generated values — IAM's ES256 signing keys, the IAM RPC key, the proxy key, the
provisioning key, the Operations sync key and the control vault KEK
(`packages/provider-zerops/src/installation/secrets.ts`) — plus one minted on the account: a Zerops
INTEGRATION token (`POST /client/{id}/integration-token`, client role `NO_ACCESS`, `ADMIN` on this
project only), so the installation never holds the personal token the operator authenticated with.
Exactly one value is printed: the provisioning key, once, at the end, because it lives
nowhere else, and `platform init` reads it from `FABRIKA_IAM_PROVISIONING_KEY`.

Fresh install always leaves GitHub source anonymous: it writes no App private key or webhook secret.
Public repositories therefore deploy without another setup step.

Both passes and the integration-token mint have run live on a fresh account
([archive](../archive/sprint-2026-08-07-zerops-from-scratch-install.md)).

### `fabrika platform deploy --provider=zerops --source-dir=.`

Both ordering rules in the [platform facts](zerops-platform.md), plus the manifest composition, live in code:
`packages/provider-zerops/src/installation/deploy.ts`. On Zerops the command owns the WHOLE ordered sequence —
prepare the committed source snapshot, resolve the project and its services, write each service's environment,
deploy IAM + Operations concurrently, then proxy and then Control, ensure the public entry point,
and reconcile the console's schema — so an operator's pipeline calls one step. On Cloudflare the same command stays narrow and
the scaffolded workflow keeps the order. The asymmetry is deliberate
([ADR-0027](../decisions/0027-platform-deploy-is-as-wide-as-the-provider-needs.md)); its full flag and
variable surface is the `usage` string in `packages/provider-zerops/src/installation/index.ts`.

Both `platform deploy` and `platform install` require `--source-dir` naming the clean full checkout
that contains the executing installation module. They refuse `--from-git` and
`FABRIKA_ZEROPS_BUILD_FROM_GIT`. The source is prepared once from a resolved commit before remote
mutations; all four setups are checked before writes. Each service reserves its own app version,
uploads that snapshot, builds the reserved version and polls its ID. No fallback selects a Git pipeline.
The first-install proxy pass and subsequent full pass share the same snapshot.

Install and deploy also derive Control's `FABRIKA_ZEROPS_PROXY_SOURCE_JSON` default from that snapshot's
commit and original descriptor, with the canonical public release repository coordinates. The JSON
environment representation escapes `$` as `\u0024` so Zerops does not interpolate references inside
the embedded descriptor; JSON decoding restores the exact bytes covered by its digest. Updating this
default does not modify existing namespace pins. An unpublished local commit cannot be fetched by
control's anonymous GitHub source; namespace source resolution must succeed before its provider mutations.

An ambiguous build response is observed without another submission or deletion; an unresolved wait
does not prove that the version failed. Namespace proxy sources are separately persisted and are not
pinned merely by selecting this installation checkout.

Three behaviours worth knowing before reading that file:

- **The manifest is MERGED.** On the light tier an application shares the project and therefore the
  platform proxy's one `FABRIKA_PROXY_MANIFEST_JSON` — the light-tier installation carried `notes` → `notesapi:3000`
  beside the three platform apps. Application entries are carried through unchanged; an entry standing
  on one of the platform's own public hosts is superseded and reported, because a host belongs to
  exactly one app.
- **Hosts come from `zeropsSubdomain` unless the operator names them.** That variable is a NAME and not
  a state (see the [platform facts](zerops-platform.md)), so it can be read one step before `enableSubdomainAccess`. Naming all three hosts
  instead marks the installation `custom-domain`, and no subdomain is published.
- **Every variable is read and compared before it is written**, through `GET /service-stack/{id}/env`,
  so a re-run writes nothing. `putServiceEnv` itself stays write-first — it must also work on a service
  that has never been deployed.

Measured against the live `fabrika-test` on 2026-08-06 with `--dry-run` (reads only): of the
per-installation variables the command derives, only `ENVIRONMENT` on `operations`, `control` and
`proxy` and the proxy manifest differ from what was placed by hand. Every origin — `ISSUER`,
`FABRIKA_CONTROL_DOMAIN`, `OPERATIONS_ARTIFACT_ORIGIN`,
`FABRIKA_OPERATIONS_PUBLIC_HOST`, `FABRIKA_IAM_ISSUER`, `FABRIKA_ZEROPS_PROXY_IAM_URL` — reproduces the
live value byte for byte, and the composed manifest reproduces `vozka`, `operations` and `notes`
identically while replacing `iam-local` with `iam`.

### The platform proxy manifest

**The platform installation's proxy manifest is generated in two halves.** The installation-independent
half — which apps exist, their ids, their private upstreams, the public listener each answers on and
their service tables — is declared in `packages/platform-artifacts/src/proxy-manifest.ts` and rendered into
the committed `packages/provider-zerops/src/installation/generated/platform-proxy-manifest.ts` by `bun run --filter
@fabrika/platform-artifacts gen`; CI's `gen:check` fails when it drifts from `controlServiceContract`,
`OPERATIONS_PUBLIC_SERVICE` or IAM's service table. A table entry is resolved into an installation entry (ADR-0022 "Installation
entries") with `serviceProxyTable`. The hosts and the browser-facing scheme belong to one installation and are
bound at deploy time by `resolvePlatformProxyManifest` (`packages/provider-zerops/src/installation/proxy-manifest.ts`).
`localPlatformProxyManifest` (`@fabrika/local-stack`) is a CALLER of the same generator with the local
hosts, so the two compositions can no longer disagree; `compileNamespaceProxyManifest`
(`republishProxy` in `packages/provider-zerops/src/namespace/proxy-attempt.ts`) remains separate — it builds an APP namespace's manifest
from the control registry.

IAM's app id on a deployed installation is `iam`. The live document said `iam-local` until this
generator replaced it, inherited from the local composition it was copied from at bring-up; the id is
inert because every row of IAM's table is a `protocol` or `health` row, for which the proxy mints no
token, so correcting it costs nothing.

## Where each credential lives

| Credential                        | Held by                                                                             |
| --------------------------------- | ----------------------------------------------------------------------------------- |
| Zerops personal access token      | The operator only. Used by `install`, stored nowhere.                               |
| Zerops integration token          | The `control` service's environment, and the sidecar GitHub Environment.            |
| Provisioning key                  | The `iam` and `control` services' environments, and the sidecar GitHub Environment. |
| Signing keys, vault key, RPC keys | The environments of the services that use them. Nowhere else.                       |
| GitHub App id and private key     | Control's vault, next to the connection's webhook secret.                           |
| Machine keys                      | Whoever they were issued to. `key issue` prints each one once.                      |

The vault key cannot be recovered or re-rolled. Losing the Zerops project's service environments loses
every secret the control plane holds.
