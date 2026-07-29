# @fabrika/engine

The provider-neutral deploy executor. It depends only on `@fabrika/provider-contract` and receives one
explicit `RuntimeProvider` from the caller's composition root.

## Layout

- `deploy.ts` — opens a provider session, executes its ordered plan and owns step lifecycle,
  progress logging, cancellation and the final result.
- `src/__tests__/deploy.test.ts` — exercises the executor with a third fake provider.
- `index.ts` — the small public API plus contract type re-exports.

The public call is `deploy(provider, run)`.

## Invariants

- Provider selection is static and explicit. Do not add a provider registry, default provider or
  closed provider-id union.
- The engine never interprets provider envelopes or `ProviderJobSpec.kind`.
- The provider session owns plan derivation and step execution. The engine executes steps by id in
  the order supplied.
- The engine stops after the first failed or cancelled step and marks the rest `skipped`.
- The engine abandons its wait when `run.signal` aborts. Providers receive the same signal and remain
  responsible for stopping underlying work.
- Provider-specific source, API clients, manifests, CLIs and collaborators belong in provider
  packages.
- Never log credentials or secret values.

## Checks

```bash
bun test packages/engine/src/__tests__/deploy.test.ts
bun run --filter @fabrika/engine typecheck
```
