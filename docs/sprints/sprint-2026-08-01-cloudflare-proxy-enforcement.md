# Sprint: Cloudflare proxy enforcement

**Started:** 2026-08-01
**Theme:** implement backlog item 47

## Outcome

Pending.

## Goal

Make the Cloudflare composition enforce the same proxy gates as the Zerops composition. Public traffic must enter a thin Cloudflare proxy Worker, pass the shared TypeScript authorizer, and reach the application only through a private Worker service binding.

## Scope

- Add the Cloudflare proxy Worker adapter and authoring helper.
- Make the Cloudflare provider provision, migrate, deploy, and secret-sync nested application Workers.
- Compose the first-party Cloudflare app, control, and Operations Workers behind the proxy.
- Add local Lopata coverage for the Cloudflare proxy boundary.
- Update tests and reference docs to describe the implemented boundary.

Out of scope:

- Removing the in-process `PropustkaAuth` compatibility path. That is backlog item 18.
- A shared Cloudflare proxy namespace spanning multiple independently deployed apps.
- A real Cloudflare account deployment.

## Verified starting point

- `packages/proxy/src/service.ts` already exposes the shared `/verify` decision service used by Caddy.
- `packages/provider-cloudflare/src/provider.ts` currently provisions and deploys only one root Worker and syncs secrets from its root directory.
- `packages/provider-cloudflare/src/plan.ts` currently finds D1 bindings only on the root Worker.
- Cloudflare app authoring currently puts public routes on the application Worker itself.
- `packages/local-stack/` exercises Caddy plus the shared proxy service, but does not execute the Cloudflare Worker adapter.
- `oblaka-iac` supports nested Worker bindings and returns a generated Wrangler config for each Worker in the graph.

## Work units

### WU1 — Cloudflare proxy adapter

**Touch points:** `packages/provider-cloudflare/src/proxy.ts`, `packages/provider-cloudflare/src/proxy-worker.ts`, provider package exports and dependencies.

**Acceptance:**

- The proxy parses the strict manifest and fails closed on invalid configuration.
- It evaluates gates through `@fabrika/proxy` and the IAM service binding.
- It forwards only allowed requests to the app Worker service binding.
- It strips client-supplied `X-Fabrika-Token` and forwards only a verified token.
- It preserves method, body, and response streaming.
- It has unit coverage for allow, login/deny, invalid token, and bypass resistance.

**Verify first:** inspect the existing `createVerifyService` response contract and proxy manifest shape.

### WU2 — Nested Cloudflare lifecycle

**Touch points:** `packages/provider-cloudflare/src/provider.ts`, `packages/provider-cloudflare/src/plan.ts`, provider tests.

**Acceptance:**

- Provisioning keeps all generated Wrangler configs for the graph.
- Deploy runs once for every generated Worker config.
- D1 migration steps target the Worker that owns each database.
- Managed environment variables and secrets target the private app Worker, not the proxy.
- Existing single-Worker provider behavior remains covered.

**Verify first:** inspect `oblaka-iac` generated config paths and current provider collaborator test doubles.

### WU3 — First-party compositions and local witness

**Touch points:** control, Operations, example app configs; Lopata config and local-development docs.

**Acceptance:**

- Control, Operations, and the example app expose only the proxy route.
- Their application Workers have no public routes.
- Each proxy binds IAM and its app Worker and carries the correct gate manifest.
- The example composition runs through the Cloudflare proxy in Lopata.

**Verify first:** inspect existing gate definitions and generated config tests before changing names or bindings.

### WU4 — Documentation and closure

**Touch points:** reference docs, sprint index, backlog item 47, archive.

**Acceptance:**

- Reference docs describe the current Cloudflare boundary and local test path.
- The sprint run log records commands and outcomes.
- The sprint closes with an `OUTCOME` section, moves to `docs/archive/`, and backlog item 47 is removed.

## Run log

| Date       | Work                                                                      | Verification                | Result                                                                                                        |
| ---------- | ------------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 2026-08-01 | Re-verified proxy, provider, composition, and local-stack starting points | repository inspection       | Starting point recorded above                                                                                 |
| 2026-08-01 | Added Cloudflare proxy Worker adapter and strict manifest forwarding      | provider proxy tests        | Public, human, service, malformed-manifest, token-stripping, body, and response cases pass                    |
| 2026-08-01 | Made the Cloudflare lifecycle graph-aware                                 | provider tests              | Managed values target `APP`; nested D1 migration and every generated Worker config are exercised              |
| 2026-08-01 | Moved Control, Operations, and example routes behind proxy roots          | composition tests           | App Workers have no routes; proxy roots own custom domains and `APP` bindings                                 |
| 2026-08-01 | Disabled `workers.dev` on private application Workers                     | composition and proxy tests | Direct public Worker subdomains are rejected by the composition helper                                        |
| 2026-08-01 | Added proxy package dependencies to the runner image workspace            | Docker workspace test       | The complete first-party dependency closure is copied into the image                                          |
| 2026-08-01 | Ran the Cloudflare example through Lopata                                 | local curl witness          | `/public/hello` returned `200 public`; `/private` returned the IAM `302` login bounce                         |
| 2026-08-01 | Ran workspace quality checks                                              | typecheck, lint, and tests  | Typecheck passed; lint passed with existing repo diagnostics; 1410 tests passed and 134 backend tests skipped |

## OUTCOME

Pending.
