# @fabrika/platform-artifacts

Private, dev-time codegen for the Zerops platform installation (ADR-0011). It writes the committed
artifacts that `@fabrika/provider-zerops/installation` ships or describes, and checks them in CI.

```bash
bun run --filter @fabrika/platform-artifacts gen            # write every artifact
bun run --filter @fabrika/platform-artifacts gen:check      # exit 1 if anything on disk differs (CI)
bun run --filter @fabrika/platform-artifacts check:schemas  # report upstream schema drift; writes nothing
bun run --filter @fabrika/platform-artifacts gen:schemas    # refetch the pinned upstream schemas
```

## Layout

- `src/render.ts` — writes or checks: the root `zerops.yaml`, `generated/*.zerops-import.yaml`, and
  `provider-zerops/src/installation/generated/*.ts`. Every Zerops document is schema-validated before it is written.
- `src/proxy-manifest.ts` — the three fronted apps and their gates. The ONE declaration of the platform's
  app list; `local-stack` imports it through `./proxy-manifest`.
- `src/console-schema.ts` — the console's `AppSchema`, copied from `@fabrika/control` as data.
- `generated/` — committed import documents. Generated; never hand-edit.
- `schemas/` — pinned upstream JSON schemas, `refresh.ts` and the read-only drift `check.ts`.
- `src/__tests__/` — drift and contract tests over the generated artifacts, including the example app.
- `src/__tests__/service-parity/` — work unit B10's proof that each service contract allows only what its gates
  allowed: `frozen.ts` (the gates and `defineApp` routes before B10, as data), the differential
  `service-parity.test.ts` (method × path × credential through the real proxy decision: verdict, injected credential,
  selected row against the route it replaces, every accepted difference listed), and `route-coverage.test.ts` (every
  route maps to its rows or explicitly to none). Never edit a frozen copy to make a test pass; list the difference.
  Deleted with the gates in B10h.

## Invariants

- This package exists so that `@fabrika/provider-zerops/installation` never imports a private package. Code that
  needs `@fabrika/control` or another private package to produce an artifact belongs here, and its
  output reaches the published package as DATA in `provider-zerops/src/installation/generated/`.
- The topology, setups and artifact values are owned by `provider-zerops/src/installation/topology/`; this package
  imports them through `@fabrika/provider-zerops/installation/topology` and never redeclares them.
- Keep credentials out of every generated artifact.
