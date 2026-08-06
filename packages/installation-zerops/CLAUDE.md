# @fabrika/installation-zerops

The Zerops implementation of `@fabrika/installation-contract` plus the typed
platform topology and generated installation artifacts.

The public command is `fabrika platform plan --provider=zerops`. It validates
the generated artifacts against Zerops' published schemas. Real-account `init`
and `deploy` remain unsupported until the installation has been exercised with
real credentials.

## Layout

- `src/index.ts` — exported `installationCli`.
- `src/proxy-manifest.ts` — the proxy manifest TEMPLATE type and `resolvePlatformProxyManifest`.
- `zerops/setups.ts` — typed IAM, Operations, control, and proxy setup definitions.
- `zerops/topology.ts` — project and service topology.
- `zerops/proxy-manifest.ts` — the three fronted apps and their gates. **Dev-time only.**
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
- Every managed service names its `profile` explicitly. An import cannot change
  one afterwards, and omitting it silently buys `oltp-production` on HA.
- Every setup declares both `run.healthCheck` (liveness) and
  `deploy.readinessCheck` (the deploy gate), with every duration written as a
  quoted Go duration inside `[10s, 1h]`. `zerops/validate.ts` retypes the six
  duration properties the published schema gets wrong; do not widen that list
  without a live observation.
- A PostgreSQL URL is always
  `${<host>_connectionString}/${<host>_dbName}?sslmode=require`.
- **`zerops/proxy-manifest.ts` and `zerops/render.ts` are EXCLUDED from the published `files`, and that
  is load-bearing.** Both import `@fabrika/control` — a PRIVATE package — through a devDependency, so
  shipping either would put an unresolvable import in the tarball. What ships instead is
  `src/proxy-manifest.ts` (types + resolver) and `zerops/generated/platform-proxy-manifest.ts` (the gate
  sets, as data). A deploy command must read those two and never reach the generator; if you add a file
  here that imports a devDependency, exclude it in the same change.
- **The proxy manifest is split into a committed template and a deploy-time placement.** The template
  is installation-independent (ids, upstreams, listener ports, gates) and `gen:check` proves it still
  matches the gate modules. Hosts and scheme are one installation's, so they are arguments. A
  `ProxyManifest` cannot carry the template alone — `parseProxyManifest` refuses an app with no hosts —
  which is why the template is a type of its own rather than a manifest with the hosts left empty.
- `enableSubdomainAccess` in a generated artifact is a DECLARATION, never a mechanism: the platform
  accepts it and drops it. Applying a `zerops-subdomain` artifact publishes nothing until an operator
  calls `PUT /service-stack/{id}/enable-subdomain-access` on the deployed proxy, and the artifact's
  generated header says so. Do not remove that header note without removing the field too.
