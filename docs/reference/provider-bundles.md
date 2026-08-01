# Static provider bundles

fabrika has an open provider contract and two concrete provider packages. An
installation links exactly one concrete provider into its runtime composition
root. Shared code receives that provider explicitly.

## Package boundary

| Package                            | Owns                                                                                                                                |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `@fabrika/provider-contract`       | JSON value/envelope types, typed codecs, runtime deploy sessions, control capabilities, and provider-neutral authoring contracts.   |
| `@fabrika/provider-cloudflare`     | Oblaka-based app authoring, Cloudflare codecs and plan, collaborators, control adapter, runner job contract, and internal executor. |
| `@fabrika/provider-zerops`         | Zerops app authoring, manifest compiler, schema/API client, codecs and plan, and control adapter.                                   |
| `@fabrika/engine`                  | Ordered execution of one explicit `RuntimeProvider` session, including step state, logs, failure, and cancellation observation.     |
| `@fabrika/control`                 | Provider-neutral registry, persistence, queue semantics, locking, run status, secret resolution, and HTTP API.                      |
| `@fabrika/installation-contract`   | Open platform `init`, `plan`, and `deploy` command contract.                                                                        |
| `@fabrika/installation-cloudflare` | Cloudflare account bootstrap and platform deployment composition.                                                                   |
| `@fabrika/installation-zerops`     | Zerops platform topology, generated artifacts, and plan validation.                                                                 |

`@fabrika/platform` is a separate boundary. It describes host-runtime
capabilities such as SQL, queues, blobs, locks, assets, and background work. A
composition root supplies both the runtime adapters and the provider bundle.

## Runtime contract

A provider defines typed target and artifact codecs and opens a deploy session:

- `ProviderModule` exposes typed target/artifact encoders and its opaque
  `RuntimeProvider`.
- `RuntimeProvider.open(run)` validates the envelopes and returns a
  `ProviderDeploySession`.
- The session supplies an ordered `ProviderDeployPlan` and executes one step id
  at a time.
- `@fabrika/engine` owns generic step status and calls the session. It does not
  interpret the target, artifact, or open-ended step `kind`.

The runtime call has no default provider:

```ts
deploy(provider, run)
```

Callers construct `provider` in their provider-specific composition code.

## Control contract

The control plane receives one `ControlProvider`. Every provider implements:

- `normalizeRegistration` to validate and canonicalize its target and artifact;
- `deploy` to start or execute one run.

A provider may also implement:

- `cancel` for platform-owned work;
- `reconcile` for unfinished external operations;
- `secrets` for immediate writes to provider-managed secret storage.
- `namespaces` for provider-owned placement validation, resource claims,
  provisioning, reconciliation, and operator planning.

Every deploy receives a provider-neutral `managedEnvironment` map assembled by
control. The current reserved values are the source-scoped
`FABRIKA_OPERATIONS_DSN` and deploy-scoped `FABRIKA_RELEASE`. Providers merge
these values at their native deployment seam and reject app-authored collisions.
The Cloudflare provider passes them through the runner job; the Zerops provider
writes them as service-level variables before triggering the platform build.
`null` removes a previously managed value. The remaining question of making
those Zerops writes activation-consistent with an asynchronously successful app
version is tracked in
[backlog 37](../backlog/37-activate-zerops-managed-environment-transactionally.md).

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
bindings and the separate runner service. The provider owns
`CloudflareRunnerJob`; `@fabrika/runner-contract` owns only the transport
protocol, `@fabrika/runner-container` executes the job, and
`@fabrika/runner-cloudflare` hosts and relays the container. None of the runner
packages owns provider plan semantics.

The Zerops installation starts at `packages/control/src/node/server.ts`.
`node/provider.ts` composes `@fabrika/provider-zerops` with the neutral engine,
Zerops credentials, and the proxy-manifest synchronization hook. Deploy
execution stays in the Bun process. `createZeropsControlProvider` requires an
executor; the composition root injects `@fabrika/engine` and there is no
provider-local fallback lifecycle. Accepted app-version ids are reconciled
through the provider capability after restarts. Control then records the
terminal run and projects its terminal release state to Operations before
releasing the run lock.

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
`InstallationCli` from `@fabrika/installation-contract`:

```text
fabrika platform init --provider=cloudflare <account>
fabrika platform plan --provider=cloudflare --runner-config=<path> --worker-config=<path>
fabrika platform deploy --provider=cloudflare --runner-config=<path> --worker-config=<path>
fabrika platform plan --provider=zerops
```

Cloudflare supports all three installation operations. Zerops currently supports
only mutation-free `plan`, which validates the generated installation artifacts;
real-account `init` and `deploy` stay unavailable until that path is exercised.
The CLI maps the official `cloudflare` and `zerops` ids to their installation
packages and treats any other provider value as an importable package specifier.

For app commands, provider selection comes from the default-exported
provider-authored config. An explicit `--provider` is required only when no app
config is available.

The architectural constraints and rejected dynamic-registry alternative are in
[ADR-0011](../decisions/0011-static-provider-bundles.md).
