# Example app — consuming Fabrika IAM over a service binding

A minimal `@fabrika/app` Worker that uses **`@fabrika/auth`** middleware to authenticate a request
through the IAM Worker via a service binding (`oblaka` `ServiceReference('propustka-worker')`), then
does local `can()` / `scopedTo()` checks and emits a fire-and-forget audit event. See
the portable [`src/app.ts`](./src/app.ts) application and its
[`src/index.ts`](./src/index.ts) Cloudflare entrypoint.

In a real app you would add only the `IAM` binding to your existing Worker; here it is a whole
tiny Worker so the example runs standalone.

## Run it locally (multi-worker lopata)

```bash
# from the repo root: generate the IAM config, then generate the proxy + app configs
cd packages/iam && bun run oblaka
cd ../../examples/app && bun run oblaka

# run the proxy as the main worker with the private app and IAM Workers wired in as auxiliaries
bun run dev          # lopata on http://127.0.0.1:18190

curl -i http://127.0.0.1:18190/public/hello
curl -i http://127.0.0.1:18190/private
```

Expected boundary witness:

```
HTTP 200
public

HTTP 302
Location: http://localhost:18191/auth/login?redirect=...
```

The first response proves that the public gate passed through the proxy and reached the private app
Worker. The second proves that an unauthenticated protected request stopped in the proxy and bounced
to IAM. The Lopata log must show `APP -> propustka-example-app` and `IAM -> propustka-worker` service
bindings. The app Worker has no public route and disables `workers_dev`, so calling its Worker
directly is not a bypass path.

The Cloudflare proxy uses the same TypeScript authorizer as the Zerops Caddy stack. Unit conformance
tests cover verified token injection, invalid credentials, login redirects, body streaming, and
client-token stripping.

## Declare + push the app's authz schema (authorization-as-code)

This app OWNS its authz vocabulary — scope dimensions, an action catalog, and roles — and
DECLARES it in code in [`fabrika.schema.ts`](./fabrika.schema.ts) as a typed `AppSchema`
(imported from `@fabrika/auth-core`). The same actions/dimensions appear in the `can()` /
`scopedTo()` calls in [`src/index.ts`](./src/index.ts), so the declaration is the single
source of truth for what the app checks.

A provisioning step reconciles that declaration into IAM via the idempotent admin
endpoint `PUT /admin/apps/:app/schema`. The first reconcile is what REGISTERS the app with
IAM. Run [`scripts/provision-schema.ts`](./scripts/provision-schema.ts):

```bash
# from this dir — dry-run prints the intended reconcile, pushes nothing
bun run provision-schema -- --dry-run

# push against a running Worker (local: ENVIRONMENT=local dev bypass → no auth needed)
FABRIKA_IAM_URL=http://127.0.0.1:18191 bun run provision-schema

# remote: the admin API is gated by IAM itself — supply an IAM-issued `px_` admin key
FABRIKA_IAM_URL=https://iam.example.com \
FABRIKA_IAM_ADMIN_KEY=px_… \
bun run provision-schema
```

Reconcile is idempotent: it upserts the app's scopes/actions/`origin='app'` roles, deletes
app-origin rows you removed, and never touches admin-composed `origin='custom'` policies. The
first reconcile registers the app id (`example-app`); after that it self-mirrors on every push.

The schema is attached to [`fabrika.config.ts`](./fabrika.config.ts), so a Cloudflare provider
deploy reconciles it automatically. This example keeps the explicit command too, so the IAM
flow can be exercised without a full deploy.

## Managed Operations configuration

A Fabrika-managed deploy reserves and injects two application variables:

- `FABRIKA_OPERATIONS_DSN` identifies the application environment's
  source-bound, write-only Sentry-compatible ingest endpoint.
- `FABRIKA_RELEASE` identifies the deploy-owned immutable release.

Do not declare either name in `fabrika.config.ts`; the provider rejects an
app-authored collision. The Cloudflare runner receives both values with the
deploy job and uploads bounded source maps through a separate release-scoped
credential when artifacts exist.

This example does not yet initialize a Sentry browser SDK. That application-level
witness is tracked in
[backlog 35](../../docs/backlog/35-prove-operations-browser-and-sdk-workflows.md);
do not treat the managed variables alone as proof of SDK compatibility.

## Note: the harmless `auth_log` error

In this standalone setup the auxiliary IAM Worker's local D1 is a fresh, unmigrated database
(the example dir has its own `.lopata/`), so the fire-and-forget `auth_log` write fails with
`no such table: auth_log` in the logs. **This does not affect the response** — which is exactly
the point of audit hard-requirement #6 (audit/auth writes use `waitUntil` and must never fail
or delay the user-facing operation). To silence it, apply the worker's migrations to the D1
this lopata instance uses, or run the IAM Worker standalone (`packages/iam`, where the D1 is
migrated) and point an app at it.
