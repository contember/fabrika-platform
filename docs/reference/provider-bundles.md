# Static provider bundles

fabrika has an open provider contract and two concrete provider packages. An
installation links exactly one concrete provider into its runtime composition
root. Shared code receives that provider explicitly.

## Package boundary

| Package                        | Owns                                                                                                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@fabrika/provider-contract`   | JSON value/envelope types, typed codecs, the `ControlProvider` contract, the shared `runSteps` helper, authoring contracts; `/installation` command contract. |
| `@fabrika/provider-cloudflare` | Oblaka-based app authoring, codecs, plan, collaborators, control adapter; `/runner` runner job and protocol; `/installation` account bootstrap and deploy.    |
| `@fabrika/provider-zerops`     | Zerops app authoring, manifest compiler, schema/API client, codecs, plan, control adapter; `/installation` topology, plan validation, ordered deploy.         |
| `@fabrika/control`             | Provider-neutral registry, persistence, queue semantics, leases, run status, secret resolution, and HTTP API.                                                 |
| `@fabrika/installation-init`   | The operator-side `platform init` mechanics both `/installation` subpaths share: prompts, `gh`, and the sidecar scaffold.                                     |
| `@fabrika/platform-artifacts`  | Private. Zerops installation codegen: the rendered `zerops.yaml`, import YAMLs, proxy manifest, and console schema.                                           |

`@fabrika/platform` is a separate boundary. It describes host-runtime
capabilities such as SQL, queues, blobs, locks, assets, and background work. A
composition root supplies both the runtime adapters and the provider bundle.

## Deploy steps

Each provider's `deploy()` builds its own ordered step list and runs it through
`runSteps` (`packages/provider-contract/src/steps.ts`). `runSteps` records step
status and logs, stops at the first failure, and observes cancellation between
steps. It does not interpret the target, the artifact, or a step's kind. There
is no shared plan type, no runtime session, and no engine package.

## Control contract

The control plane receives one `ControlProvider`. Every provider implements
`id` and `deploy` (start or execute one run). A provider may also implement:

- `normalizeRegistration` to validate and canonicalize its target and artifact;
  absent means control stores the registration as submitted;
- `resolveSource` to resolve a requested source revision before deployment;
- `source: { binding: 'connection' | 'installation' }` to accept a private-source binding, which
  Control then passes as `sourceBinding` to `resolveSource` and `deploy`;
- `cancel` for platform-owned work;
- `reconcile` for unfinished external operations;
- `secrets` for immediate writes to provider-managed secret storage.
- `namespaces` for provider-owned placement validation, resource claims,
  provisioning, reconciliation, proxy republishing, and operator planning;
- `declaredVariables` to name the variables an artifact declares.

The bound-source inputs and credential-free `ProviderSourceBinding` are declared
once in `@fabrika/provider-contract`. Control loads the exact connection and
installation coordinates from persistence; a bound operation refuses a missing
capability or mismatched coordinates rather than using an unbound fallback.

Every deploy receives a provider-neutral `managedEnvironment` map assembled by
control: `FABRIKA_RELEASE`, `FABRIKA_IAM_ISSUER`, and the source-scoped
Operations keys (`FABRIKA_OPERATIONS_DSN`, `FABRIKA_APP_ID`,
`FABRIKA_ENVIRONMENT`, `FABRIKA_SERVICE_KEY`). `null` removes a previously
managed value. Providers merge these values at their native deployment seam and
reject app-authored collisions. The Cloudflare provider passes them through the
runner job. The Zerops provider writes `FABRIKA_RELEASE` into the execution
descriptor of the version it builds and every other key as a service variable
([ADR-0044](../decisions/0044-zerops-delivery-ownership-and-recovery.md)).

An optional `artifactUpload` contains the bounded, release-scoped Operations
source-map endpoint and bearer. The Cloudflare runner consumes it where the build
files exist. The Zerops provider does not yet have a corresponding build-side
artifact hook; see
[backlog 36](../backlog/36-complete-zerops-release-artifact-correlation.md).

Shared lifecycle code calls these capabilities directly. It does not select from
a runtime registry and does not branch on `cloudflare` or `zerops`.

The namespace capability receives the provider-neutral
`ProviderDeploymentNamespace` coordinates and an opaque target envelope. Its
optional operator surface publishes provider-defined presets, produces a
mutation-free plan, and renders safe facts and instructions. The control plane
does not interpret provider preset ids or plan options. See
[`deployment-namespaces.md`](deployment-namespaces.md).

## Persistence boundary

Provider-owned data crosses the control boundary as:

```json
{
	"provider": "provider-id",
	"version": 1,
	"payload": {}
}
```

The registry stores the canonical target and artifact envelopes in
`app_envs.provider_target_json` and `app_envs.provider_artifact_json`. Runs store
the provider operation id in `runs.external_run_id`. Provider credentials do not
belong in these envelopes; each composition root supplies them only for live
operations.

Managed environment values and artifact-upload credentials are per-run inputs.
They are never persisted inside provider target or artifact envelopes.

Deployment namespaces have their own provider envelope in
`deployment_namespaces.provider_target_json`. `app_envs.namespace_id` assigns an
environment to a placement. Core stores provider resource keys in
`namespace_resource_claims`; the provider derives the keys, while shared
persistence owns their atomic and immutable assignment.

The selected provider rejects an envelope with a different provider id or an
unsupported codec version. A new provider can define a different payload without
adding provider-specific columns or fields to shared control code.

## Composition roots

The Cloudflare installation starts at `packages/control/src/index.ts`.
`platform-cf.ts` composes `@fabrika/provider-cloudflare` with native Worker
bindings and the separate runner service. `@fabrika/provider-cloudflare/runner`
owns `CloudflareRunnerJob` and the runner protocol, `@fabrika/runner-container`
executes the job, and `@fabrika/runner-cloudflare` hosts and relays the
container. Neither runner package owns provider plan semantics.

### Cloudflare source and runner admission

`createCloudflareControlProvider` requires three separate collaborators:

| Option                         | Contract                                                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `resolveSource(input)`         | Return the verified immutable `commitSha` through the neutral `ProviderSourceResolutionInput` / `ProviderSourceResolution` contract. |
| `prepareClone(source, signal)` | Return `CloudflareCloneSource`, containing only the ephemeral `repoUrl`. It cannot replace the selected ref.                         |

Custom compositions use `CloudflareCloneSource` for clone authorization. The
`resolveSource` option selects source identity; it does not return a clone URL.
`startRun`, cancellation and recovery retain their separate execution roles.

The GitHub composition verifies a recorded commit directly. Without one, it
resolves the requested concrete ref once. Qualified heads and tags preserve their
namespaces; bare names try the exact branch first and the exact tag only after
404. Ref-selected annotated tags peel to commits. Recorded non-commit objects
fail. Public resolution uses anonymous GitHub data requests; private resolution
uses the recorded installation's repository-scoped read-only token.

Control persists the selected commit under its ownership fence before creating
the release context. The original requested ref remains in run history. Non-dry
`CloudflareRunnerJob.ref` must contain a complete lowercase 40-hex GitHub commit.
The runner fetches that object, detaches HEAD and compares the observed commit
before installing dependencies or running repository commands. It logs the
expected/actual commit witness. Git authorization stays in the Git child's
environment, outside argv, persisted Git configuration and repository children.
Runtime release and source-map upload scope use Control's frozen release for
that same commit. Missing or mismatched objects fail without a branch fallback.

There is no source-protocol handshake: the runner Worker and image are rolled
forward before Control (ADR-0048). Errors after submission retain recovery
semantics because work may already have started.

Dry mutable-ref previews retain branch/tag cloning and release-unavailable
semantics. A dry full-SHA preview uses exact checkout verification. Dry previews
do not upload source maps.

The contract decision is [ADR-0048](../decisions/0048-bind-cloudflare-delivery-to-the-recorded-commit.md).
The detached runner/image precedes Control in an operator-owned rollout; see
[`release-process.md`](release-process.md#deployment-boundary).

### Zerops composition

The Zerops installation starts at `packages/control/src/zerops/server.ts`.
`zerops/provider.ts` composes `@fabrika/provider-zerops` with the Zerops access
token, control's in-process GitHub source (`packages/control/src/source/`, App
keys from the vault), and the namespace inputs. Deploy execution stays in the
Bun process. Recorded app-version ids are reconciled through the provider
capability after restarts: polled when the build was requested, deleted when it
was not. Control then records the terminal run and projects its terminal release
state to Operations before releasing the run lease.

### Shared lifecycle ownership

`@fabrika/platform` supplies the shared SQL lease implementation. Acquisition is non-reentrant;
release matches the holder. `renew(key, holder, ttlMs)` extends only a still-live lease owned by that
holder, using one conditional update. Control wraps it in one primitive (`packages/control/src/lease.ts`):
a 90 s TTL renewed every 30 s, with a local deadline one renew period before the stored expiry. Runs,
namespace jobs, terminal repair and the Operations catalog sync all use it. Failed renewal or a missed
local deadline aborts the lease's signal. Lease loss stops the invocation; it does not request external
cancellation.

Every run lifecycle write is holder-checked: `RunRepository` locks the run's `<app>:<env>` lease row
and writes only while that holder's lease is live, in the same database transaction. There is no
checkpoint compare-and-swap. A cancellation request changes no lifecycle state; the lease holder reads
it at its next step boundary.

An unresolved provider result keeps the run running after the invocation releases its lease. That row
blocks a later deployment until recovery establishes settlement. Cancellation similarly remains
requested until the provider returns `settled`; acknowledgement alone is insufficient. Cloudflare
runner recovery fences delayed startup before settling a never-dispatched run, while dispatched work
retains its detached completion backstop.

`packages/control/src/__tests__/entrypoint-isolation.test.ts` walks both import
graphs. It verifies that each root reaches only its selected provider and runtime,
while shared control modules reach neither concrete provider.

## Authoring and commands

Cloudflare apps import their config surface from
`@fabrika/provider-cloudflare`:

```ts
import { defineApp, Worker } from '@fabrika/provider-cloudflare'
```

Cloudflare app resources are composed as a public proxy Worker with a private
application Worker child. The child has no routes and explicitly disables
`workers.dev`. The provider preserves the generated Wrangler config for every
Worker in that graph, deploys each config, and targets application migrations,
managed variables, and secrets at the child Worker. The proxy embeds only its
manifest and service bindings; application secrets stay on the child.

The public command exposes:

```text
fabrika app deploy --env=<env> [--config=<path>] [--dry-run]
```

The provider is inferred from the provider-authored config. The
`fabrika-cloudflare-executor` binary is internal to the runner container; it is
not an operator surface.

Zerops apps import their config surface from `@fabrika/provider-zerops`:

```ts
import { defineApp } from '@fabrika/provider-zerops'
```

Its build command evaluates app-owned TypeScript before registration:

```text
fabrika app build --env=<env> [--config=<path>] [--output=<path>]
```

The resulting `fabrika.manifest.json` is the provider-owned artifact. The control
plane validates and stores it, then performs deployments without importing the
app's TypeScript.

The same public command exposes the provider-owned namespace operator:

```text
fabrika namespace plan --id=<id> --env=<env> --preset=<cheap|mid|full>
fabrika namespace create --id=<id> --env=<env> --preset=<cheap|mid|full>
fabrika namespace adopt --id=<id> --env=<env> --preset=<cheap|mid|full> --project-id=<id>
fabrika namespace reconcile --id=<id>
```

`plan` runs without mutation. `create` and `adopt` submit the provider-generated
namespace envelope to the control API. `reconcile` resumes the stored,
checkpointed lifecycle.

## Installation commands

`@fabrika/cli` is the only public executable. Platform commands select an
`InstallationCli` from `@fabrika/provider-contract/installation`:

```text
fabrika platform init --provider=cloudflare <account>
fabrika platform plan --provider=cloudflare (--runner-config=<path> --worker-config=<path> | --component-config=<path>)
fabrika platform deploy --provider=cloudflare (--runner-config=<path> --worker-config=<path> | --component-config=<path>)
fabrika platform init --provider=zerops <installation> [--repo=<owner>/<name>]
fabrika platform plan --provider=zerops
fabrika platform install --provider=zerops --client-id=<id> --env=<name> [--project-id=<id> | --create-project [--project-name=<name>]]
fabrika platform deploy --provider=zerops [options]
fabrika platform upgrade --provider=zerops --to=<tag> [<installation>] [--sidecar=<path>|<owner>/<name>]
```

Both providers support all three operations, and **how wide each one is, is the
provider's own answer** ([ADR-0027](../decisions/0027-platform-deploy-is-as-wide-as-the-provider-needs.md)).
Zerops' `plan` is mutation-free and validates the generated installation
artifacts. Its `deploy` owns the whole ordered sequence, while Cloudflare's
composes the runner/control pair and the scaffolded workflow keeps the order. Its
`init` creates and maintains the operator's sidecar repository for an installation
that already exists; on Zerops the first bring-up is `platform install`, which can
also create the project it installs into; it is two passes, because a proxy that
has never been deployed publishes no hostname for the manifest to carry.
`fabrika platform <command> --provider=<name> --help` prints the installation's own
surface. The CLI maps the official `cloudflare` and `zerops` ids to
`@fabrika/provider-<cloud>/installation` and treats any other provider value as an importable package
specifier.

For app commands, provider selection comes from the default-exported
provider-authored config. An explicit `--provider` is required only when no app
config is available.

The architectural constraints and rejected dynamic-registry alternative are in
[ADR-0011](../decisions/0011-static-provider-bundles.md).
