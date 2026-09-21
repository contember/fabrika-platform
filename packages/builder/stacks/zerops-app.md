---
id: zerops-app
title: "Platform-managed Zerops app — Bun + PostgreSQL + Fabrika IAM"
goal: "Build and verify a local React/Buzola app behind real IAM and proxy gates, then deploy its available Git revision through installed Fabrika Control."
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
- `zerops-fabrika-auth` supplies IAM token verification and proxy-only gates.
- `zerops-local-app` composes the Bun application, SPA and local IAM/proxy loop.
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
2. Start the app's documented local composition: PostgreSQL, IAM, proxy and Bun
   runtime. Apply migrations and the scenario's PostgreSQL seeds locally.
3. Open the app's **proxy URL**, complete IAM login, and run the targeted opice
   scenario against that URL. Verify denied access with a real restricted identity.
4. Run application unit tests, typechecking and its production asset build.
   Include the built assets in the root `zerops.yaml` deploy files.
5. Report the actual local preview URL and checks. Production deployment follows
   `zerops-control-deploy`; a passing local test is not a successful remote run.

The public notes example supplies the backend/config reference, not a ready-made
SPA or arbitrary-project dev launcher. Scaffold and verify the local composition
described in `zerops-local-app` before claiming the application runs locally.
