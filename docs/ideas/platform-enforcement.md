# Platform enforcement of the application contract

The [opinionated application framework](opinionated-app-framework.md) makes the safe way the easy way and turns an
agent's honest mistakes into errors. It runs inside the application process and the application's own build, so an
agent that edits any file can still loosen it: change a role, add a public gate, drop a check from the build. This
proposal makes the framework's contract **binding from outside the application**: the proxy, IAM, Control and the
providers enforce what a human approved, read from the commit being deployed.

The work is planned in [the implementation plan](app-framework-implementation-plan.md) (part B). Design rule: no new
services and no multi-step orchestration; every step extends an existing component.

## Threat model

The person driving the agent does not read the diff. They describe a feature, the agent writes it, and they deploy
when it "works". The agent is competent but optimizes for "works": when a request is refused, it loosens whatever
refused it — the contract, table policies, roles, gates, `zerops.yaml`, build commands.

Two authoring paths reach the platform:

- **A local agent** with the builder or the CLI (ADR-0042): it has a shell, the repository and a builder key.
- **A hosted agent over MCP** (Claude or ChatGPT through Control's MCP tools): it has no shell; it edits files of a
  workspace branch, deploys to staging, and opens a pull request for production.

What this proposal must stop, beyond the framework:

1. **A widened front door or role** that nobody notices — an anonymous endpoint, an action added to a role everyone
   holds, a weaker requirement.
2. **Bypassing the declarations** — a hand-written gate, a server started outside the generated entrypoint, a build
   that skips the checks, a direct dial to the application service.
3. **Authenticated mistaken for authorized at the edge** — a token that carries cross-application grants or another
   environment's grants.
4. **Provider-level exposure** — a public bucket, subdomain access, a direct binding to another application.

**Assumptions:** the agent holds no provider token and no IAM administrator session, and does not drive the
approver's own signed-in browser. Without these, every layer below is optional for the agent.

**Out of scope for v1** (each with a named later step in the plan): deliberate sabotage of the build toolchain by
an authored SPA command, isolation between applications that share a cheap namespace, proof of physical human
presence at approval, revocation faster than the token lifetime.

## Principles

- **Hard guarantees live outside the application process.** The proxy, IAM, Control and the provider enforce the
  contract read from the commit — never a description the running application or an upload reports.
- **One declaration, many enforcers.** The same contract the framework uses; nothing is written twice.
- **Loosening is loud.** A change that widens access waits for a human on a protected environment.
- **ADR-0022 holds.** The proxy stays the only component that decides whether a request reaches the application.

## 1. The proxy decides per endpoint

The contract compiles to one row per endpoint: `{ id, kind, method, path, callers, requirement, digest }`. The
proxy's manifest carries this table instead of gates for every contract application; gates remain only for the
installation's own services, chosen by Control's metadata.

**The decision**, one pass over the selected endpoint:

1. The raw path must be canonical (no empty segment, `.`, `..`, encoded `/` or `\`); otherwise 400. A trailing `/`
   is significant and matched literally.
2. `planEndpoint` selects the most specific endpoint: a literal segment beats a parameter, which beats a wildcard.
   No endpoint is 403. An RPC prefix is reserved.
3. A `px_` key is present → mint from it; the key's principal kind must be one of the endpoint's callers; terminal.
   Workload kinds (jobs, webhooks) are accepted by no mount.
4. No key and `human` is a caller → the session, or the login redirect.
5. The token must satisfy the requirement (membership, or the action in some scope). Otherwise 403.
6. **Admission** for a session-authenticated request that is not `GET`: `Sec-Fetch-Site: same-origin`; for RPC
   `Content-Type: application/json`; uploads admit their declared types.

A narrower endpoint now really narrows. Today an absent credential falls through to every later matching rule
(`packages/proxy-core/src/authorize.ts:167`), so a gate can only add access.

**The hop to the application is authenticated.**

- The proxy strips every client-supplied `X-Fabrika-*` header.
- It sets `X-Fabrika-Endpoint: <id>@<digest>`. The digest covers the endpoint's kind, method, path, callers,
  requirement and admission. The application dispatches by the id and answers 503 when the digest differs from its
  own — so a request is never served by code that expects different rules than the proxy applied.
- It sets a secret per application and environment, generated by Control and written as a managed variable to both
  sides. The application checks it before anything else, so a direct dial inside a Zerops namespace is refused.
- The application compares its contract's digest with `FABRIKA_CONTRACT_DIGEST` (a literal in the execution
  descriptor) at startup and refuses to start on a mismatch.

**Switching versions.** On Zerops a proxy table change is a proxy rebuild of several minutes, and Zerops activates a
new application version on its own. Because of the digest check, the order is safe either way; the publish order
stays as today (proxy, application, IAM). During a switch, changed endpoints answer 503 and new ones 404.

**Response headers.** The proxy applies the framework's header policy to every application response and to its own
denials; the application can no longer omit them. Downloads get the file treatment.

## 2. Control reads the contract from the commit

Control never executes application code (ADR-0005). It reads `fabrika.contract.ts`, the schema modules it imports
and `src/db/tables.ts` from the exact commit (the existing single-file read at a commit, on both clouds) and parses
them statically. The framework requires these files to be literals, so nothing has to run. The same reader runs in
`fabrika contract check`, in the platform build and in the checker. A form the reader refuses fails the deploy with
the file, the line and the allowed form — the only feedback an agent over MCP gets is the build log.

The application's startup digest check is the backstop: if the static reader and the runtime ever disagree, the
application does not start.

Uploads (the builder, the CLI, the dashboard) no longer carry gates or the IAM schema.

## 3. Approval

**A snapshot per deploy run** holds the parsed contract and table policies, the migration list with checksums, the
checker version, the baseline it was compared with, and the approval. `app_envs` points at the published run and
carries a generation. **One function, `approvedSnapshot(app, env)`, feeds every path that publishes a proxy table or
reconciles IAM**: the deploy, environment registration and deletion, application deletion, namespace reconcile and
jobs, provider cancel and reconcile on both clouds. Publication is a compare-and-swap on the generation. A pending
change is published nowhere.

**Classification is a conservative diff** of the normalized access data of the candidate against the environment's
active snapshot:

- endpoint callers, access forms and output fields;
- containment, roles and their actions, membership rules;
- table and column policies;
- anonymous kinds, link mounts and link-reachable file collections;
- job and webhook actions, connector exports and imports;
- CSP extensions;
- migrations (any new or changed file).

No change passes. A change that only removes passes. Everything else waits for approval on a protected
environment. The prompt lists the changes in plain language ("Role `editor` gains `notes.delete`", "New endpoint
`api.notes.export` for editors").

**Protected environments.** Only `prod` is protected by default; each environment has a flag that an IAM
administrator can change, audited. On an unprotected environment (staging, an MCP authoring target) a change applies
at once; it is classified again against production's snapshot when it is deployed there. Staging must not hold
production data.

**Who approves.** A user principal holding `access.approve` (outside the `deploy.*` wildcard every operator holds),
in the dashboard, with a same-origin request. A service principal, the builder key and any OAuth or MCP token are
refused. The approval records the candidate and baseline digests. A run that waits is reported by MCP's
`get_deployment` with the approval link.

**Rollback** is a new deploy of an older commit, classified like any other.

## 4. IAM

- **Application tokens carry only grants of that application.** Cross-application grants and bootstrap `admin`
  reach registered platform audiences only.
- **The environment is part of the application id.** The proxy mints for `notes@prod`; schemas, roles, grants, keys,
  links and return origins are therefore per environment. `@` is reserved in application ids.
- **Exact actions** in every role of a contract application, on every write path; no global grant of a role
  declared with `member.scope`. Grant writes are idempotent.
- **A narrowed application surface.** An application token cannot call `issueKey`, `revokeKey` or
  `listPrincipals`; applications call only JWKS and the membership, scope and link operations of the framework. On
  Cloudflare, applications bind a narrow IAM entrypoint.
- **Delegation grants.** For an endpoint whose action is a dimension's `members.manage`, the proxy attaches a
  single-use grant bound to the endpoint and request, and IAM requires it for membership operations. A handler such
  as `me` cannot spend an owner's authority.
- **Workload principal kinds** (`link`, `job`, `webhook`, `app`), each added with the feature that uses it. Job and
  webhook keys have their own application as audience; a connector key has the owner. The proxy refuses an unknown
  kind, on cached paths too.
- **A bound on token size**, so a person in many workspaces cannot exceed the proxy's header limit.
- **Revocation delay** is the token lifetime, 300 s, for sessions and keys including share links. Membership
  operations are checked live.

## 5. Providers

**Exposure is refused, with no approval path:** public or raw-policy buckets, subdomain access, `buildFromGit`,
inline `zeropsYaml`, `mount`, `enableCdn` on Zerops; routes, `workers_dev`, preview URLs and bindings to another
application's resources on Cloudflare. Only CSP extensions in the contract are approvable. Before activation Control
reads back `subdomainAccess`; buckets are accepted only when the platform created them private (Zerops has no API to
read a policy back).

**Zerops: the platform owns the run section and the server build.** The provider renders the execution descriptor
from the snapshot:

- `run`: `initCommands` with `fabrika db migrate`, `start` with the generated entrypoint, the crontab from the
  contract's jobs, the readiness check, `prepareCommands` from a typed allowlist, `FABRIKA_CONTRACT_DIGEST` as a
  literal. An authored `run` section is refused.
- `build`: the authored SPA commands first; then generated commands — a frozen install with lifecycle scripts off,
  a hash check of `@fabrika/*` in the lockfile, `tsc` with the platform's `tsconfig`, the checker, the contract
  check, migrations into a throwaway schema with codegen verification, the generated isolation tests, and the
  server build. No authored command runs after the checks.
- The routine ways to replace `@fabrika/*` are refused: `patchedDependencies`, `overrides`, `resolutions`,
  non-registry specifiers, `bunfig` `preload`, `tsconfig` `paths`, `declare module '@fabrika/*'`.

**Zerops: the database.** A cheap namespace is one trust boundary: its applications share the namespace Postgres
credential, and one application can read another's tables. An application that must be isolated from other
applications goes to an exclusive namespace (ADR-0014). Migrations run in the application container. Per-application
roles and row-level security are the later hardening step.

**Credential custody.** Framework-only variable names (database, storage, proxy secret, job and connector keys) are
one list, refused by both Control's `assertUnmanagedName` and the provider's `MANAGED_KEYS`. The framework reads them
and deletes them from `process.env`; `/proc/self/environ` still holds them.

**Cloudflare.** The platform builds the proxy Worker from the snapshot; an authored proxy is refused. The application
config is still imported inside the credentialed runner, so on Cloudflare the checker and type checks stay advisory
until the runner separates a credential-free step.

## 6. MCP authoring

- Today a workspace refuses edits to every `fabrika.*` file. With approval in place, the contract, its schema modules
  and `src/db/tables.ts` become editable and are governed by classification; `zerops.yaml` and `.github/` stay
  protected.
- Every refusal of the reader, the checker and the build is one short, actionable line in the build log.
- Runs record their actor, including runs created through MCP.

## Summary

| Protection                                     | Framework (in-process)                 | Platform                                       |
| ---------------------------------------------- | -------------------------------------- | ---------------------------------------------- |
| Every endpoint declares access                 | types, `implement`, generated gates    | proxy endpoint table                           |
| Authenticated ≠ authorized                     | requirement check                      | proxy requirement; application-only grants     |
| IDOR, leaked fields, client-supplied identity  | `Ref`, data layer, projection          | —                                              |
| A widened contract, role or table policy       | visible in the pull request            | conservative diff and human approval on `prod` |
| A hand-written server, raw SQL, skipped checks | checker in the template build          | generated run section and build                |
| Forged endpoint headers, direct dials          | —                                      | stripped headers, proxy secret, digests        |
| CSRF, XSS, clickjacking                        | admission and headers in the framework | admission and headers at the proxy             |
| Cross-environment credentials                  | —                                      | environment in the application id              |
| Provider exposure                              | —                                      | refusals and read-back                         |

## Binding rules that change

- **Root `CLAUDE.md`, "exactly one gate evaluator … only the proxy runs it":** holds; the application dispatches by
  the proxy-set endpoint id. "Array order is precedence" holds for installation gates only.
- **ADR-0022:** endpoint tables, caller kinds, requirements and admission at the proxy; stripped headers, the proxy
  secret and digests; workload principal kinds.
- **ADR-0005:** Control parses the contract; it still executes nothing.
- **ADR-0012:** the contract is the decision; its rejected alternative ("gates in route definitions") is met by
  static data.
- **ADR-0014:** a cheap namespace is stated as one trust boundary.
- **ADR-0042 and ADR-0049:** uploads carry no gates or schema; neither the builder key nor an MCP token can approve;
  MCP's protected paths shrink to `zerops.yaml` and `.github/`.
- **ADR-0043:** the platform-owned `run` section and server build.
- **New ADR:** approved snapshots, the conservative diff, `access.approve`, protected environments.

## Open questions

- Where do contract-driven proxy tables meet Operations' host-split surface?
- Is the approval rate on `prod` acceptable with the conservative diff, or is a reachability classifier needed?
