# @fabrika/installation-zerops

The Zerops implementation of `@fabrika/installation-contract` plus the typed
platform topology and generated installation artifacts.

The public command is `fabrika platform plan --provider=zerops`. It validates
the generated artifacts against Zerops' published schemas. Real-account `init`
and `deploy` remain unsupported until the installation has been exercised with
real credentials.

## Layout

- `src/index.ts` — exported `installationCli`.
- `zerops/setups.ts` — typed IAM, Operations, control, and proxy setup definitions.
- `zerops/topology.ts` — project and service topology.
- `zerops/render.ts` — generated artifact writer and `--check` verifier.
- `zerops/generated/` — committed installation artifacts.
- `zerops/schemas/` — pinned published schemas and refresh script.

## Invariants

- The generated root `zerops.yaml` is the only platform build specification.
  Do not add per-package `zerops.yaml` files.
- Keep credentials out of generated artifacts.
- Do not claim real-account support from schema validation or dry runs.
- Preserve the import-without-code → write service secrets → deploy bring-up
  order.
- Preserve the IAM → Operations → control deployment order. Operations owns
  separate `operationsdb` and `operationsstorage` services; only the proxy may
  expose its ingest and source-map paths.
