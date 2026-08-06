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
composition, runs database migrations, waits for health checks, and provisions the
machine API key described below.

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
8. verifies that an anonymous console `/api/*` call is refused by the PROXY, that
   the public Operations hostname refuses health, catalog and release
   reconciliation and every operator route outright — with and without a machine
   credential, because it declares no rule for them — and that it rejects an
   ingest envelope without a source credential;
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

## Signing in

The proxy is the only front door locally, exactly as it is in a deployed
installation. It fronts each host with the SAME gate declarations a
deployed proxy carries — `CONTROL_PROXY_GATES` (`packages/control/fabrika.gates.ts`)
for the console, `OPERATIONS_PROXY_GATES` (`packages/operations/src/gates.ts`) for the
public Operations host, imported rather than copied — and IAM is `public` because it
authenticates itself.
Nothing reaches an application until a gate passes, and the application only ever
verifies the token the proxy injected. There is no second way in: `@fabrika/auth`
has one code path and no local mode, so no synthetic persona exists anywhere.

Opening the console therefore runs the real round trip:

1. the proxy matches a `human` gate and answers `302` to
   `iam.fabrika.localhost:18080/auth/login?app=vozka&redirect=<original URL>&state=…&code_challenge=…`,
   after storing the verifier in a short-lived cookie on the console host;
2. IAM authenticates. `LOCAL_DEV_LOGIN=true` makes that step non-interactive: IAM
   creates a **real** session row for the `admin@local.test` bootstrap admin
   instead of calling an external IdP. It is IAM's own mechanism and is refused at
   use the moment the flag is off;
3. IAM issues a single-use code bound to `(session, vozka, return URL, challenge)` and 302s to
   `control.fabrika.localhost:18080/__fabrika/auth/callback?code=…&state=…`;
4. the proxy there redeems the code with the browser-held verifier, sets `__Host-px_session` **on the console's own
   host**, and 302s to the original URL. Every later request mints a per-app token
   from that cookie.

That session is a **global admin** — `LOCAL_DEV_LOGIN` resolves the fixed
`admin@local.test` bootstrap admin and nothing else. Everything else about an
identity is done in IAM, through the console's Access plane: `principals.invite`
creates one, and `passwords.issueEnrollment` answers with the enrolment URL
directly (`FABRIKA_EMAIL_PROVIDER` is `none`, so delivery is `manual`) — that
principal can then sign in with a password.

That is the production round trip verbatim, including the handoff, because since
[ADR-0023](../decisions/0023-one-session-per-host.md) there is no other way for a
session to reach an application's host — no cookie is shared between hosts, and
`__Host-` makes the browser enforce it. What makes it work locally is that `local:up`
**registers the local apps with IAM** once the composition is healthy: `vozka` with
`http://control.fabrika.localhost:18080` and `notes` with
`http://notes.fabrika.localhost:18081`, through the same `reconcileSchema` call a
deploy makes. Locally nothing deploys fabrika into its own composition, so the stack
stands in for the deploy — the same way it already provisions the machine key. An app
IAM has no return origin for answers `400` naming the address rather than trying
something else.

Because the console is now a registered app, a **non-admin role is grantable
locally**: `vozka`'s `operator` role and its action catalog are in IAM from the first
`local:up`, so an inline `deploy.read` grant or a role assignment resolves. There is
no persona switch to fall back on, and adding one back would be a second
authentication model.

The **browser** composition (`browser:up`, `test:browser`) runs the same services
with `LOCAL_DEV_LOGIN` off. Its scenarios seed a real principal, grant and `sessions`
row directly in IAM, plant that login on **IAM's host**, and then drive the real
handoff once per application host to obtain each host's own session. Nothing there is
a shortcut past the proxy, and every request the suite makes is still gated and
answered with an IAM-minted token. With the bypass off, the suite can also drive an
unauthenticated browser and observe the proxy's `302` to IAM.

## Calling the API from a script

`/api/*` admits either a logged-in human or a `px_` **service key**, so a script
needs one. `local:up` provisions one through IAM's admin surface and writes it to
`packages/local-stack/.state/machine.env` as `FABRIKA_LOCAL_MACHINE_KEY`; the smoke
test uses it. `FABRIKA_IAM_PROVISIONING_KEY` does not work here: IAM resolves it
for its own `/admin/*` surface and it has no credential row, so the proxy refuses
it before control sees the bearer.

```bash
KEY=$(grep FABRIKA_LOCAL_MACHINE_KEY packages/local-stack/.state/machine.env | cut -d= -f2-)
curl -H "Authorization: Bearer $KEY" http://control.fabrika.localhost:18080/api/namespaces
```

The generated credentials, the machine key and the proxy manifests live under the
ignored `packages/local-stack/.state/` directory. They remain stable across
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

The unified console is reached through the proxy and authenticated by IAM; there
is no synthetic persona anywhere in the composition, and no code that could
produce one. Access requests cross the
real control-to-IAM gateway. Operations requests cross the transport-only control
gateway to the private Operations operator API. Machine bootstrap, app API keys,
access-token minting, JWKS verification, schema reconciliation, Operations
catalog/release projection, and managed app environment assembly use the real
services.

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
