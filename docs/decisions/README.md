# decisions (ADR)

One file per significant architectural or product decision: `NNNN-<slug>.md`. Copy
[`_template.md`](_template.md). Numbers are monotonic and never reused; gaps are
deleted or merged ADRs.

**Living until 1.0.** Each ADR states its decision as it stands now. To change
course, rewrite the ADR in place; merge two ADRs that decide one question and delete
the absorbed one. There are no superseded ADRs — git holds the history.

Write one when the choice (a) constrains future work, (b) rejected a real
alternative, or (c) someone will later ask "why did we do it this way?". Otherwise
a commit message suffices.

## Where to start

- **Provider model:** [0011](0011-static-provider-bundles.md) — one static provider bundle per
  installation; the provider owns its deploy; one public package per cloud.
- **Authentication and authorization:** [0022](0022-the-proxy-is-the-only-enforcement-point.md) —
  the proxy is the only enforcement point; then [0023](0023-one-session-per-host.md) for the
  browser-bound session handoff, [0050](0050-approved-access.md) for how access changes are
  approved and published, and [0051](0051-external-principals.md) for people from outside the organization.
- **Application framework:** [0012](0012-fabrika-app-runtime.md) — one contract built with the staged kit,
  handlers beside their endpoints on a paved road, and every step off it (raw SQL, `unscoped`, connectors, link
  issuing, database code) declared; [0017](0017-service-owned-postgres-migrations.md) for migrations and the
  application's database roles, the privilege boundary under raw SQL.
- **Zerops delivery:** [0003](0003-no-deploy-runner-on-zerops.md) (Control drives Zerops over HTTP),
  [0029](0029-github-app-sources.md) (GitHub App sources, multiple connections),
  [0044](0044-zerops-delivery-ownership-and-recovery.md) (release binding, recovery, one lease).
  Platform facts several of these rest on live in
  [`../reference/zerops-platform.md`](../reference/zerops-platform.md).
- **Cloudflare delivery:** [0048](0048-bind-cloudflare-delivery-to-the-recorded-commit.md); run
  ownership for both clouds is in [0044](0044-zerops-delivery-ownership-and-recovery.md).
- **Ownership of installs:** [0025](0025-the-operator-installs-the-platform-fabrika-deploys-apps.md)
  and [0027](0027-platform-deploy-is-as-wide-as-the-provider-needs.md).

## Index

| ADR                                                                     | Decision                                                                                 |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| [0003](0003-no-deploy-runner-on-zerops.md)                              | No deploy runner on Zerops — Control drives the platform over HTTP                       |
| [0004](0004-secrets-live-in-the-platform.md)                            | App secret values live in the target platform, or in the vault where it has none         |
| [0005](0005-compile-app-config-to-static-manifest.md)                   | Compile app config to a static manifest; the control plane never executes app code       |
| [0006](0006-zerops-project-topology-is-a-registry-field.md)             | Zerops project topology is a registry field, defaulting to project-per-environment       |
| [0011](0011-static-provider-bundles.md)                                 | Compose one static provider bundle per installation; the provider owns its deploy        |
| [0012](0012-fabrika-app-runtime.md)                                     | One contract built with the staged kit, served by `serve`; steps off the road declared   |
| [0013](0013-explicit-runtime-adapter-entrypoints.md)                    | Expose runtime adapters through explicit package entrypoints                             |
| [0014](0014-provider-owned-deployment-namespaces.md)                    | Model deployment namespaces as provider-owned placement boundaries                       |
| [0015](0015-repository-operations-are-the-sql-portability-seam.md)      | Make repository operations the SQL portability seam                                      |
| [0016](0016-independent-operations-plane.md)                            | Add an independent Operations plane                                                      |
| [0017](0017-service-owned-postgres-migrations.md)                       | Make Postgres migrations service-owned and bundle-qualified                              |
| [0019](0019-portable-outbound-email.md)                                 | Keep outbound email behind one portable service contract                                 |
| [0020](0020-compose-human-authentication-methods.md)                    | Compose OIDC and password as independent human authentication methods                    |
| [0022](0022-the-proxy-is-the-only-enforcement-point.md)                 | The proxy is the only enforcement point                                                  |
| [0023](0023-one-session-per-host.md)                                    | One session per host, bound to the browser that started the login                        |
| [0024](0024-canonical-environment-names.md)                             | Canonical plane-qualified environment names, with no legacy fallback                     |
| [0025](0025-the-operator-installs-the-platform-fabrika-deploys-apps.md) | The operator installs the platform; fabrika deploys only apps                            |
| [0027](0027-platform-deploy-is-as-wide-as-the-provider-needs.md)        | `platform deploy` is as wide as its provider needs, not uniformly wide                   |
| [0028](0028-zerops-apps-own-their-repository-root.md)                   | Zerops apps own their repository root                                                    |
| [0029](0029-github-app-sources.md)                                      | Operator-owned GitHub Apps deliver application sources                                   |
| [0033](0033-operate-the-control-plane-from-the-cli.md)                  | Operate the control plane from the CLI                                                   |
| [0034](0034-the-control-plane-creates-the-projects-it-owns.md)          | The control plane creates the projects it owns                                           |
| [0035](0035-the-platform-owns-the-application-iam-issuer.md)            | The platform owns the application's IAM issuer, and an undeclared variable is refused    |
| [0038](0038-size-namespaces-cheaply-by-default.md)                      | Size namespaces cheaply by default                                                       |
| [0040](0040-share-one-token-verifier.md)                                | Share one token verifier between the SDK and the proxy                                   |
| [0041](0041-one-administrative-transport-for-control-and-operations.md) | One administrative transport for Control and Operations                                  |
| [0042](0042-connect-local-builders-through-human-consent.md)            | Connect local builders through human consent                                             |
| [0043](0043-validate-and-render-one-zerops-descriptor-meaning.md)       | Validate and render one Zerops descriptor; the platform owns `run` and the server build  |
| [0044](0044-zerops-delivery-ownership-and-recovery.md)                  | Zerops delivery binds the release, recovers by poll or delete, and runs under one lease  |
| [0045](0045-upload-immutable-platform-and-namespace-proxy-sources.md)   | Upload immutable installation and namespace proxy sources                                |
| [0048](0048-bind-cloudflare-delivery-to-the-recorded-commit.md)         | Bind Cloudflare delivery to the recorded application commit                              |
| [0049](0049-author-applications-through-mcp-in-control.md)              | Author applications through an MCP endpoint in Control over Git workspaces               |
| [0050](0050-approved-access.md)                                         | Publish only approved access; a human approves widenings, declared deviations included   |
| [0051](0051-external-principals.md)                                     | External principals hold only roles declared external                                    |
| [0052](0052-react-and-an-own-component-kit-for-application-spas.md)     | Build application SPAs with React, hooks over the typed client, and an own component kit |
