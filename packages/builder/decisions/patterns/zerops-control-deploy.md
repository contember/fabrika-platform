---
id: zerops-control-deploy
kind: pattern
title: Deploy Zerops applications through installed Fabrika Control
slot: deploy-control-plane
provides: [managed-deploy, release-tracking]
requires: [zerops-platform, zerops-fabrika-auth]
recommends: []
conflicts: [app-deploy, vozka-app-deploy]
status: wip
sources:
  - where: "packages/control-contract/src/rpc.ts + packages/provider-zerops/src/provider.ts in fabrika-platform"
    read: "Current Control deployment contract and provider lifecycle; do not infer builder command syntax."
  - where: "examples/zerops-app/README.md + fabrika.config.ts + zerops.yaml in fabrika-platform"
    read: "Application-owned source artifacts versus platform-owned deployment and secrets."
  - where: "docs/decisions/0050-approved-access.md in fabrika-platform"
    read: "The access snapshot Control reads from each commit, and which changes wait for a person's approval."
---

# Deploy through installed Control

Apply this to an application bound to an existing Fabrika installation. The human
creates or selects the app in the installed console and reviews its environment
and placement. Repository creation, the GitHub connection, namespace provisioning
and custom-domain binding remain administrator-owned prerequisites. Missing
prerequisites are a handoff to that administrator.

## Responsibilities

- The local agent implements, tests and prepares the application config and build
  descriptor. It keeps the selected application identity stable on later changes.
- The human controls commits and pushes. Deployment consumes an immutable commit
  already available in the configured remote repository; do not substitute an
  uncommitted tree or automatically create another application on retry.
- Installed Control owns registry updates and deployment orchestration. Preserve
  the reviewed namespace, source and public origin when updating an environment.
- Control and the Zerops provider supply credentials server-side, deliver source
  and trigger Zerops' build/deploy pipeline. The local coding agent does not need
  a Zerops account token or an installation provisioning credential.
- Control reads the contract, `src/db/tables.ts` and the migration list from the
  deployed commit and publishes only that approved snapshot to the proxy and IAM.
  A widening (a new endpoint, caller, role grant, table policy change or migration)
  on a protected environment (`prod` by default) parks the run in
  `awaiting_approval` until a person approves it in the console. The agent cannot
  approve; it reports the parked run and what the change lets someone do.
- Follow the Control run to its terminal result and verify its requested revision
  and public proxy URL. A successful build, a trigger response or a local emulator
  result alone is not proof of a successful production release.

Do not deploy through `zops push`, direct provider API calls or a parallel
application-owned deployment workflow. Do not route a public domain directly to
the runtime service. App secrets remain platform-held service variables; keep
credentials out of source, manifests, browser state and compiler inputs.

This decision defines the deployment boundary. Consult the implemented CLI help
and workflow instructions for invocation syntax; it defines no builder connection
or deployment commands.
