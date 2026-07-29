# Static provider bundles

fabrika has an open provider contract and two concrete provider packages. An
installation links exactly one concrete provider into its runtime composition
root. Shared code receives that provider explicitly.

## Package boundary

| Package                        | Owns                                                                                                                                   |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `@fabrika/provider-contract`   | JSON value/envelope types, typed codecs, runtime deploy sessions, control capabilities, and provider-neutral authoring contracts.      |
| `@fabrika/provider-cloudflare` | Oblaka-based app authoring, Cloudflare codecs and plan, collaborators, control adapter, runner job contract, and `fabrika-cloudflare`. |
| `@fabrika/provider-zerops`     | Zerops app authoring, manifest compiler, schema/API client, codecs and plan, control adapter, and `fabrika-zerops`.                    |
| `@fabrika/engine`              | Ordered execution of one explicit `RuntimeProvider` session, including step state, logs, failure, and cancellation observation.        |
| `@fabrika/control`             | Provider-neutral registry, persistence, queue semantics, locking, run status, secret resolution, and HTTP API.                         |

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

Shared lifecycle code calls these capabilities directly. It does not select from
a runtime registry and does not branch on `cloudflare` or `zerops`.

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

The selected provider rejects an envelope with a different provider id or an
unsupported codec version. A new provider can define a different payload without
adding provider-specific columns or fields to shared control code.

## Composition roots

The Cloudflare installation starts at `packages/control/src/index.ts`.
`platform-cf.ts` composes `@fabrika/provider-cloudflare` with native Worker
bindings and the separate runner service. The provider owns
`CloudflareRunnerJob`; `@fabrika/runner` validates, transports, and executes that
job without owning provider plan semantics.

The Zerops installation starts at `packages/control/src/node/server.ts`.
`node/provider.ts` composes `@fabrika/provider-zerops` with the neutral engine,
Zerops credentials, and the proxy-manifest synchronization hook. Deploy
execution stays in the Bun process; accepted app-version ids are reconciled
through the provider capability after restarts.

`packages/control/src/__tests__/entrypoint-isolation.test.ts` walks both import
graphs. It verifies that each root reaches only its selected provider and runtime,
while shared control modules reach neither concrete provider.

## Authoring and commands

Cloudflare apps import their config surface from
`@fabrika/provider-cloudflare`:

```ts
import { defineApp, Worker } from '@fabrika/provider-cloudflare'
```

The provider CLI exposes:

```text
fabrika-cloudflare deploy --env=<env> [--config=<path>] [--dry-run]
fabrika-cloudflare platform deploy [--env=<env>] --runner-config=<path> --worker-config=<path> [--build-runner-image] [--dry-run]
```

Zerops apps import their config surface from `@fabrika/provider-zerops`:

```ts
import { defineApp } from '@fabrika/provider-zerops'
```

Its build command evaluates app-owned TypeScript before registration:

```text
fabrika-zerops build --env=<env> [--config=<path>] [--output=<path>]
```

The resulting `fabrika.manifest.json` is the provider-owned artifact. The control
plane validates and stores it, then performs deployments without importing the
app's TypeScript.

The architectural constraints and rejected dynamic-registry alternative are in
[ADR-0011](../decisions/0011-static-provider-bundles.md).
