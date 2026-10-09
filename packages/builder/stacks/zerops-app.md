---
id: zerops-app
title: "Platform-managed Zerops app — Bun + PostgreSQL + Fabrika IAM"
goal: "Build and verify a local React/Buzola contract application behind real IAM and the proxy's endpoint table, then deploy its available Git revision through installed Fabrika Control."
decisions:
  - zerops-platform
  - bun
  - postgres
  - react
  - buzola
  - tailwind
  - zerops-fabrika-auth
  - zerops-local-app
  - zerops-control-deploy
  - zerops-postgres-seeds
  - opice
build: "see §Local verification below"
---

# Stack: zerops-app

The supported catalog path for a **platform-managed Zerops application**: a
long-running Bun application with PostgreSQL and a client-rendered React/Buzola
UI. Coding agents and application development run locally. The installed Control
service owns production deployment.

**Maturity:** Fabrika, Buzola and opice are evolving 0.x components. This preset is
an explicit opt-in to that stack, not a claim of general production readiness.
Read installed contracts and the linked public examples before scaffolding.

## Composition

- `zerops-platform` owns provider configuration and private runtime services.
- `zerops-fabrika-auth` supplies the contract (`fabrika.contract.ts`), which the
  proxy enforces as an endpoint table and the framework serves through `implement`.
- `zerops-local-app` composes the generated Bun entrypoint, the SPA mount and the
  local IAM/proxy loop.
- `zerops-control-deploy` defines the human/admin/agent deployment boundary.
- `zerops-postgres-seeds` preserves opice's named SQL fixture contract on PostgreSQL.

The selection is requires-closed and occupies each exclusive slot once. Reuse
`bun`, `postgres`, `react`, `buzola`, `tailwind` and `opice`. Their optional
recommendations do not select Cloudflare tooling or another router. The D1-only
`named-seeds` decision is not part of this preset.

## Entry conditions

The human creates or selects the application in the installed console and reviews
its environment and destination. An administrator owns repository creation,
GitHub connection, namespaces and domain routing. The agent uses the selected app
identity in local source and configuration; it does not provision an installation
or choose a replacement destination when prerequisites are missing.

## Local verification

1. Install with Bun and typecheck the actual provider config and application.
   After any change to the contract or `src/db/tables.ts`, run `fabrika db migrate`,
   `fabrika db codegen` and `fabrika db test-scaffold`, and commit what they write.
2. Start the app's documented local composition: PostgreSQL, IAM, proxy and the
   generated Bun entrypoint. Apply migrations and the scenario's PostgreSQL seeds
   locally.
3. Open the app's **proxy URL**, complete IAM login, and run the targeted opice
   scenario against that URL. Verify denied access with a real restricted identity.
4. Run application tests with `FABRIKA_TEST_POSTGRES_URL` set, `fabrika-check`,
   typechecking and the production asset build. The SPA's build commands go in
   `build.buildCommands` of the root `zerops.yaml`; the platform generates every
   other key and deploys the checked build.
5. Report the actual local preview URL and checks. Production deployment follows
   `zerops-control-deploy`; a passing local test is not a successful remote run.

The public notes example (`fabrika.contract.ts`, `src/db/tables.ts`,
`db/migrations/`, `src/app.ts` and its generated tests, plus an `attachments` file
collection and a `purge` job) supplies the backend/config reference, not a
ready-made SPA or arbitrary-project dev launcher. Its `AGENTS.md` carries the
`fabrika-app` rules. Scaffold and verify the local composition
described in `zerops-local-app` before claiming the application runs locally.
