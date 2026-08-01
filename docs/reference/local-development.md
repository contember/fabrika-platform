# Local Zerops-targeted stack

The local stack runs Fabrika's real runtime components in Docker before a
credentialed Zerops deployment. It validates Fabrika behavior and network
boundaries. It does not validate Zerops infrastructure behavior.

## Prerequisites

- Bun with the repository dependencies installed
- Docker with Compose v2
- `cpu-lease`, used to build the unified console

## Commands

Run these commands from the repository root:

```bash
bun run local:up
bun run local:status
bun run local:smoke
bun run local:down
```

`local:up` generates stable local credentials, builds the unified console, starts the
composition, runs database migrations, and waits for health checks.

`local:smoke` is intentionally disruptive. It:

1. creates or reuses the cheap `apps-prod` namespace with shared PostgreSQL;
2. registers the notes app from its compiled Zerops manifest;
3. triggers a deploy and waits for an external app-version id;
4. hard-kills control while the emulated pipeline is `BUILDING`;
5. starts control after the pipeline becomes `ACTIVE` and verifies startup
   reconciliation plus terminal release projection;
6. verifies the explicit notes `publicOrigin`, stable managed ingest
   configuration, and deploy-scoped release values on the app service;
7. checks the reconciled IAM schema, public and authenticated proxy routes, and
   a real notes write to PostgreSQL;
8. verifies that the public Operations hostname hides health, catalog, and
   operator routes and rejects an ingest envelope without a source credential;
9. sends a credentialed Sentry envelope and observes one source-scoped issue
   after asynchronous Postgres queue consumption;
10. stops Operations, persists duplicate queued deliveries, restarts the real
    consumer, and proves stable issue identity, exactly-once counting, and queue
    drain;
11. proves the notes container cannot reach the private control or Operations
    networks.

To discard all local databases, object data, emulator state, and generated
credentials, use:

```bash
bun run local:reset
```

This command removes only the `fabrika-local` Compose volumes and
`packages/local-stack/.state/`. It then creates and starts a fresh stack.

## Endpoints

| Component                | URL                                      |
| ------------------------ | ---------------------------------------- |
| Unified Fabrika console  | `http://control.fabrika.localhost:18080` |
| IAM auth and public JWKS | `http://iam.fabrika.localhost:18080`     |
| Operations public ingest | `http://errors.fabrika.localhost:18080`  |
| Notes example app        | `http://notes.fabrika.localhost:18081`   |

The local IAM login creates a real `admin@local.test` session without contacting
an external OIDC provider. It is enabled only by the local composition. All local
browser origins share the `fabrika.localhost` parent so the SSO cookie reaches the
console and example applications.

The generated credentials and proxy manifests live under the ignored
`packages/local-stack/.state/` directory. They remain stable across
`local:down`/`local:up` and rotate on `local:reset`. Do not copy them into
tracked files.

## Runtime boundary

The composition runs these real components:

- IAM, Operations, control, and notes Bun servers;
- their real PostgreSQL migrations and data stores;
- MinIO through the production S3-compatible run-log and Operations blob-store
  adapters;
- the Operations Postgres job consumer and scheduled health/notification
  maintenance;
- the proxy authorization service and Caddy in shared network namespaces;
- separate private `platform` and `apps-prod` networks.

The unified console uses its built-in local admin persona, so Delivery, Access,
and Operations open without an external OIDC provider. Access requests still
cross the real control-to-IAM gateway. Operations requests cross the
transport-only control gateway to the private Operations operator API. Machine
bootstrap, app API keys, access-token minting, JWKS verification, schema
reconciliation, Operations catalog/release projection, and managed app
environment assembly use the real services.

Notes can reach the public IAM address through the narrow `iam-public` network
to fetch JWKS. It cannot resolve or reach the private control, platform
PostgreSQL, MinIO, IAM RPC, or Operations services.

The stateful Zerops emulator implements only the REST calls used by
`@fabrika/provider-zerops`: projects, services, service variables, imports, and
app-version lifecycle. A delayed `BUILDING` to `ACTIVE` transition provides a
restart-reconciliation witness. The emulator does not build code, run
containers, bind domains, autoscale, provide HA, or reproduce Zerops logs.

## Cloudflare Worker proxy witness

The local stack above exercises the Zerops-shaped Caddy boundary. The Cloudflare
thin Worker is exercised separately with Lopata:

```bash
cd packages/iam && bun run oblaka
cd ../../examples/app && bun run oblaka && bun run dev
curl -i http://127.0.0.1:18190/public/hello
curl -i http://127.0.0.1:18190/private
```

The first request reaches the private example app through the proxy and returns
`200 public`. The second stops at the proxy and returns a login redirect. Lopata
must show `APP -> propustka-example-app` and `IAM -> propustka-worker`; the app
Worker config has no public route and sets `workers_dev: false`.
