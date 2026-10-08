# @fabrika/platform-artifacts

Private, dev-time codegen for the Zerops platform installation (ADR-0011). It writes the committed
artifacts that `@fabrika/installation-zerops` ships or describes, and checks them in CI.

```bash
bun run --filter @fabrika/platform-artifacts gen            # write every artifact
bun run --filter @fabrika/platform-artifacts gen:check      # exit 1 if anything on disk differs (CI)
bun run --filter @fabrika/platform-artifacts check:schemas  # report upstream schema drift; writes nothing
bun run --filter @fabrika/platform-artifacts gen:schemas    # refetch the pinned upstream schemas
```

## Layout

- `src/render.ts` — writes or checks: the root `zerops.yaml`, `generated/*.zerops-import.yaml`, and
  `installation-zerops/src/generated/*.ts`. Every Zerops document is schema-validated before it is written.
- `src/proxy-manifest.ts` — the three fronted apps and their gates. The ONE declaration of the platform's
  app list; `local-stack` imports it through `./proxy-manifest`.
- `src/console-schema.ts` — the console's `AppSchema`, copied from `@fabrika/control` as data.
- `generated/` — committed import documents. Generated; never hand-edit.
- `schemas/` — pinned upstream JSON schemas, `refresh.ts` and the read-only drift `check.ts`.
- `src/__tests__/` — drift and contract tests over the generated artifacts, including the example app.

## Invariants

- This package exists so that `@fabrika/installation-zerops` never imports a private package. Code that
  needs `@fabrika/control` or another private package to produce an artifact belongs here, and its
  output reaches the published package as DATA in `installation-zerops/src/generated/`.
- The topology, setups and artifact values are owned by `installation-zerops/src/topology/`; this package
  imports them by relative path and never redeclares them.
- Keep credentials out of every generated artifact.
