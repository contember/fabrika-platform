---
id: 0049
title: Author applications through an MCP endpoint in Control over Git workspaces
status: accepted
date: 2026-10-08
---

# 0049 — Author applications through an MCP endpoint in Control over Git workspaces

## Context

Employees should build and change applications from their own Claude or ChatGPT account. The client
writes the code; Fabrika runs no model. The platform must authenticate the person, limit what they may
change, deploy their work to a stage environment, and leave production to the ordinary review and
delivery path.

An earlier exploration put the MCP server in a separate service. That service needed IAM token
delegation to reach Control, its own database for a delegation journal, and a second copy of every
authorization check. Control already owns the application registry, the deploy runs and their
authorization, and it already holds each GitHub connection's App key in its vault (ADR-0029).

A hosted agent has no shell and no local toolchain. It edits files of a workspace and reads the build
log. When a request is refused, it loosens whatever refused it. Protecting every `fabrika.*` file
stops it from widening access, but it also stops it from adding an endpoint or a table. With approval
of access changes ([ADR-0050](0050-approved-access.md)), the platform can let the agent edit the
contract and classify what it changed instead.

An agent that iterates on a handler or a screen through the stage environment waits for a full build every time. On
Zerops one build process of a small application took 80–142 s, after about 15 s of variable writes, and a Zerops
pipeline cannot go below about 51 s, because it creates a build container and deploys a new runtime container on every
run. Writing a file into a running container and restarting the application serves the change in well under a second.
Control is not reachable from a namespace (another Zerops project shares no private network with it), but a namespace
container reaches Control's public origin in 15–68 ms, a GitHub compare takes about 0.6 s, and files written at runtime
survive a service stop, start and restart (a deploy replaces the container and loses them).

A Zerops Box Workspace (a `zbox@1` service) runs microVM sandboxes inside a namespace project: one is created in about
0.26 s, parks in 1.3 s, wakes on a request in about 0.8 s, and a full recipe build in it takes about 8 s warm
([platform facts](../reference/zerops-platform.md)). That makes a sandbox per workspace cheap enough to give every
workspace its own running application, where one pinned service could show only one workspace at a time.

## Decision

1. **Control serves MCP at `/mcp`** (Streamable HTTP). Each tool calls a Control use case. MCP is a
   user-facing protocol adapter beside the RPC, like webhooks and auth callbacks; ADR-0041's single
   administrative transport is unchanged. Only the Bun/Zerops composition mounts it.
2. **IAM is the OAuth 2.1 authorization server.** Authorization code with S256 PKCE, explicit RFC 8707
   resource, refresh rotation and revocation. Clients are operator-registered Client ID Metadata
   Documents (Claude, ChatGPT); there is no open dynamic registration. A client authenticates at the token
   endpoint as its document declares: none (a public client with PKCE) or `private_key_jwt` against the
   document's own-origin key set; a request never chooses a weaker method. Every authorization response
   carries `iss` (RFC 9207). An access token is minted for
   one resource of one app. Its permissions are the user's live grants narrowed by the consented
   scope. No token delegation exists.
3. **The proxy enforces it.** `/mcp` is a `service` row of the console's installation entry that
   admits the caller `oauth`, with `oauth: { scopes }` on the row and a registered `oauthResources`
   entry for its path ([ADR-0022](0022-the-proxy-is-the-only-enforcement-point.md) "Installation
   entries"). The proxy verifies the bearer as a resource token for that resource and scopes, and serves
   the RFC 9728 resource metadata. ADR-0022 holds: Control verifies the injected token for the resource
   profile and makes no enforcement decision.
4. **A workspace is a Git branch** `fabrika/<workspace id>` created from the default branch. Edits
   are ordinary commits that name the expected head; a stale head fails. Control stores workspace
   metadata only, never file contents. Control performs every GitHub read and write itself, through
   the GitHub App of the app's connection, with the key read from its vault per operation (ADR-0029).
   The installation token stays inside the GitHub client and never reaches the MCP client.
5. **An operator marks an app environment as an authoring target.** A user may author it when they
   also hold `source.workspace.*` grants at its coordinates. One stage environment per app; deploying a
   workspace creates an ordinary run for the exact head SHA in that environment.
6. **Repository configuration is protected; the contract files are classified.** Control refuses edits
   to the provider's deploy files at any depth (`ControlProvider.authoring.protectedFiles`: `zerops.yaml` /
   `zerops.yml` on Zerops; a provider without `authoring` has no authoring target), `fabrika.*` files and everything under `.github/`; the
   operator changes them through normal review. The only exceptions are `fabrika.contract.ts`, the
   schema modules it imports, `src/db/tables.ts` and the files under `migrations/`. A workspace may
   edit them, and Control classifies those changes at deploy time instead of refusing them (ADR-0050).
   Every other `fabrika.*` file, `fabrika.config.ts` included, stays protected. A contract import does
   not lift the protection of a file that is protected otherwise.
7. **Production is not an MCP operation.** The tool opens a pull request. A human reviews and merges
   in GitHub, and the existing Delivery trigger deploys the merged commit. When that commit widens
   access on a protected environment, the run waits for approval. `get_deployment` reports a waiting
   run as `awaiting_approval` with the approval link.
8. **No MCP token approves.** An OAuth or MCP token is refused by `approvals.complete`, whatever its
   scope (ADR-0050). Every run records its actor, including runs created through MCP.
9. **Zerops only** for this version.
10. **An application may have one `dev` environment, and each MCP workspace gets its own sandbox in it.** A commit to
    a workspace reaches that workspace's running sandbox through the dev launcher, without a run. `deploy_stage` stays
    the only path to a checked build.
    - An operator registers it with kind `dev` and a `domain` (`apps.environments.put`), on Zerops only. The domain is a wildcard base:
      workspace `W` is served at `https://<W>.<domain>` (a workspace id is a UUIDv7, a valid DNS label). It is never
      production, never protected (ADR-0050), never an authoring target and has no trigger ref; it has its own role
      family, schema and approved access. Its namespace must publish custom domains (a `zerops-subdomain` namespace is
      refused) and its proxy must be built from a source that declares `FABRIKA_PROXY_MANIFEST_SANDBOXES: "2"`; otherwise
      every namespace job that would publish a sandbox entry, the bootstrap run's republish included, refuses before any
      platform write and names `fabrika control namespaces update --proxy-source=current`. It claims no Zerops service.
      Deleting it, or its app, is refused while a workspace sandbox of it is left. Its app secrets are kept in Control's
      vault ([ADR-0004](0004-secrets-live-in-the-platform.md)).
    - **The sandbox host.** A namespace with a `dev` member gets one Zerops Box Workspace service (type `zbox@1`,
      hostname `zbox`). Each workspace with a sandbox is one Box sandbox (a microVM) there, created from a base image
      with Bun and PostgreSQL. PostgreSQL runs inside the sandbox on `127.0.0.1`; `FABRIKA_APP_DATABASE_URL` points at
      it, and its data survives a re-bootstrap. Control generates the host's API key and keeps it in its vault
      (`deployment_namespaces.sandbox_key_ref`); the provider writes it to the service as `ZBOX_WORKSPACE_API_KEY`
      (sensitive, never read back) and restarts the service. Control calls the Box API over the service's public
      subdomain for port 8080 with that key ([ADR-0022](0022-the-proxy-is-the-only-enforcement-point.md) rule 1).
    - **Routing.** The namespace proxy stays the only ingress. Each workspace sandbox is its own manifest entry,
      `dev:<app>:<workspace>`, on host `<workspace>.<domain>`, upstream `zbox:8081` (the Box router), with `upstreamHost`
      `3000-<sandbox>` and `audience` `<app>@<env>` (ADR-0022 rule 3). Each workspace has its
      own proxy secret, `source` key
      ([ADR-0064](0064-applications-reach-the-platform-over-a-receiver-verified-transport-key.md) §7), IAM return origin
      and proxy table, the one its own published bootstrap run approved.
    - **Identity.** All sandboxes of the environment share one IAM application id, `<app>@<env>`, so a grant applies in
      every sandbox. IAM holds one schema for it: the one the most recently bootstrapped workspace published. When a
      workspace's contract differs from it, `get_dev_status` says so, and `bind_dev` refreshes it. The environment's
      workload and membership keys are shared the same way: a bootstrap rotates one with less than half its lifetime
      left and IAM keeps the replaced one (`keep`) until its expiry, so the other sandboxes still hold a valid key.
      Control records when the first key a sandbox holds expires (`dev_sandboxes.keys_expire_at`), and `bind_dev`
      bootstraps a sandbox again once that is inside the same margin.
    - `bind_dev` ensures the workspace's sandbox on every call, before any run: it creates the sandbox when the
      workspace has none, creates it again when Box lost it, and wakes it. The run's namespace republish needs the
      sandbox id, which stays the same for the workspace's life unless Box lost the sandbox; a replaced sandbox holds
      nothing and is bootstrapped like a new one. It then starts a **bootstrap run** (an ordinary run of
      the workspace head with the full build and every check) whenever the sandbox's launcher cannot serve the head:
      the first bind, after a failed bootstrap or a refused sync, when the paths from the head the sandbox holds to the
      workspace head change something the build owns, and when the launcher is gone. It is gone when Control cannot read
      its requests (an older or newer wire), or when it sent none for longer than it ever waits (90 s; 15 min while it
      syncs or runs the checks); after a wake, `bind_dev` waits up to 15 s for its first request. Such a sandbox is
      `needs_bootstrap`, and `apply_changes` does not wait for it. Binding one workspace never touches another's
      sandbox.
    - A bootstrap run carries a **lane**, the workspace id (`runs.lane`): a newer succeeded run supersedes only a run of
      its own lane, and publication is per lane, so one workspace's bootstrap never fails or replaces another's. The
      `<app>:<env>` deploy lease stays, so the bootstraps of one environment run one at a time.
    - The provider deploys a bootstrap into the sandbox instead of a Zerops build. It wakes the sandbox, stops the
      previous launcher and build, uploads the helper scripts of its own release, uploads the source archive of the exact
      commit (at most 50 MiB) and runs the build steps of `@fabrika/app/build`'s recipe, after the authored SPA commands,
      as an unprivileged user with a clean environment: the build reads no credential and cannot log in to PostgreSQL.
      Its output is relayed to the run log with every environment value masked. Only then does the provider write the
      launcher's environment to a root-only file through Box's file API, write the launcher's configuration, start the
      launcher and wait for it to report its boot. A credential never goes through Box's launch or exec environment:
      only that root-only file holds one, and the build runs without it. Recovery never resumes ([ADR-0044](0044-zerops-delivery-ownership-and-recovery.md)): a run
      whose invocation is lost settles failed, and the workspace binds again.
    - A sandbox gives an application less than a Zerops service. A bootstrap refuses, in one line each, runtime packages,
      object storage, the ClamAV scan (`scan: true`) and a `${…}` reference in a variable or secret. Jobs do not run in
      a sandbox: it has no crontab. The environment's app secrets are kept in Control's vault and handed at deploy, since
      a sandbox has no service variables.
    - The launcher holds a long poll on Control's public origin with its workspace's `source` key. Control answers with
      the changed files of the workspace head: the files `apply_changes` just wrote, handed over in memory, or else read
      from a GitHub compare. A launcher of a replaced bootstrap run is refused (409), so it cannot report over the new
      one. Control stores the record of each sandbox (workspace, sandbox id, target and served head, status, time, a
      trimmed log), never file contents (rule 4 holds).
    - The launcher writes the files, migrates when `db/migrations/` changed, runs the authored SPA build when a web
      source changed, respawns the application (not `bun --watch`, so it knows when the new head serves), and reports
      `{ head, status, last log lines }`. A commit that changes something the build owns (`package.json`, `bun.lock`,
      the build descriptor, generated files, which covers the framework pin) is refused in one line: it needs a
      bootstrap run. So is a commit that changes the contract: after writing the files, a child of the launcher with no
      credential computes the contract digest, and a digest other than the bootstrapped `FABRIKA_CONTRACT_DIGEST`
      restores the files and refuses the commit. The digest decides, not the paths: an edit of a handler in a module
      the contract imports syncs, and the proxy table and the approval, which follow the digest, stay true. At boot the
      launcher reconciles to the recorded head before it serves.
    - The sandbox's database still holds what the previous bootstrap left (a migration the commit edited), so a
      launcher asks Control twice at boot, first for the reset generation it applied, then for any reset still pending;
      it runs that reset, then `fabrika db migrate`, then `fabrika db codegen --verify` (again after every reset). A
      failure is the reported `failed` state, whose message names `reset_dev`; the launcher still reports its boot, so
      the bootstrap run completes and `reset_dev` reaches the launcher.
    - `run_checks` is refused while the sandbox holds another commit than the workspace's newest, and its results name
      the commit they checked.
    - `apply_changes` on a workspace with a sandbox waits up to 10 s for that report and returns
      `dev: { head, state, summary, url, log }`, `url` being the sandbox's origin, or the pending state on a timeout.
      `get_dev_status` reads the rest. The tool names and answer shapes are those of the one-service design this rule
      replaced.
    - `run_checks` runs the build's check chain (tests, `fabrika-check`, `tsc`) in the sandbox on request. It gates
      nothing. `reset_dev` drops and recreates the environment's role family and schema in the sandbox's own PostgreSQL
      and migrates from scratch. `bind_dev`, `run_checks` and `reset_dev` need `deploy.trigger`; `get_dev_status` needs
      `deploy.read`.
    - Control parks a sandbox after 30 minutes without activity; a request to a parked sandbox wakes it in about a
      second, and every call that follows the sandbox wakes it itself. Maintenance removes a sandbox whose workspace saw
      no activity for 14 days, unless a bind or commit made it active before the removal began, and any sandbox of an
      abandoned workspace; `delete_workspace` removes the workspace's sandbox at once. A removal stops routing the
      sandbox, deletes the Box sandbox, revokes the workspace's `source` keys, deletes its proxy secret and record, and
      republishes the namespace proxy. When Box fails, the keys are still revoked and the proxy republished, and
      maintenance finishes the rest.
    - Nothing from a sandbox is promoted. A commit reaches stage and production only by its own build.

Built (work unit B6): a workspace may edit `fabrika.contract.ts`, and every other `fabrika.*` file stays
protected; a widening it brings to a protected environment parks the run, and `get_deployment` reports it
with the approval link.

## Consequences

- One service owns authoring authorization; no delegation tokens, journal or second database.
- Control gains the MCP SDK dependency and a second user protocol.
- MCP cannot scale separately from Control.
- Concurrent edits are serialized by the expected head; there is no automatic rebase.
- A stage environment shows one workspace at a time. A `dev` environment shows every workspace at once, each in its own
  sandbox at its own origin.
- A `dev` environment serves a commit about 1–2 s after `apply_changes` instead of after a 2–4 minute build. What it
  serves skipped the checks; `run_checks` and `deploy_stage` are how an agent learns whether the head passes them.
- A `dev` environment costs one Box host per namespace and one sandbox per workspace with a sandbox. A running sandbox
  reserves its whole memory on the host, and a full host refuses a new or woken sandbox; `bind_dev` says so. A bootstrap republishes the namespace proxy and takes
  its lease ([ADR-0044](0044-zerops-delivery-ownership-and-recovery.md)); a sync is not a Zerops operation and takes
  none.
- A sandbox holds what a stage container holds, plus its workspace's `source` key. Unreviewed code there can read that
  key, which reads only that workspace's source. The visitor's token the proxy injects reaches that code too
  (ADR-0022, "Consequences").
- In a sandbox, jobs do not run. That is accepted for a dev environment.
- Rollout: Control's migrations add `dev_sandboxes`, `runs.lane`, `app_envs.iam_digest`,
  `platform_transport_keys.workspace_id` and `deployment_namespaces.sandbox_key_ref`, all empty or null on an existing
  installation. `platform upgrade` regenerates the namespace proxy setup with `FABRIKA_PROXY_MANIFEST_SANDBOXES`, but a
  namespace keeps its pinned proxy until `fabrika control namespaces update --proxy-source=current`. The namespace job
  imports the `zbox` service once a `dev` member has a workspace sandbox record, keys it and restarts it. Migration 0027
  drops `dev_environments`: the bound workspace, target head and launcher report of a pinned dev service are discarded.
  A `dev` environment registered for the one-service design is not migrated, and `bind_dev` and a dev deploy refuse it.
  The operator deletes its Zerops service, releases its claims, deletes the environment, registers it again with a
  wildcard domain whose DNS points at the namespace proxy, and sets its app secrets again: a secret row that still
  names a Zerops variable fails the bootstrap with "set its value again". Until then its old domain stays routed. No
  deploy writes to the old service again, so its variables stay until it is deleted
  ([MCP authoring](../reference/mcp-authoring.md#upgrading-an-installation-with-a-dev-environment)). An application gets a `dev` environment only
  when an operator registers one and its framework release ships the launcher
  ([ADR-0062](0062-a-platform-release-serves-older-framework-releases.md)).
- The application owns its data and data authorization; the platform does not isolate generated code
  from the app's database.
- An agent can add endpoints, roles and tables without an operator. A stage environment is not
  protected by default, so the change applies there at once; on production a widening waits for a
  human.
- Every refusal of the checker and the build must be one short, actionable line in the build log,
  because that log is the agent's only feedback. Control's snapshot reader is the exception: it logs
  before the run's secrets are known, so it gives a fixed code and a count, and `fabrika-check` names the
  problems ([ADR-0050](0050-approved-access.md)).

## Alternatives considered

- **Separate MCP service with IAM token delegation.** Lost: a token exchange and journal write per
  call, authorization in two places, another service and database to operate.
- **Separate MCP gateway forwarding a multi-audience token.** Lost: token passthrough to Control RPC,
  which the MCP specification warns against, and a weaker audience check in every verifier.
- **Keep every `fabrika.*` file protected.** Lost: the agent cannot add an endpoint or a table, so
  every feature needs an operator. Classification makes the change visible to a human instead.
- **Open every `fabrika.*` file, or `fabrika.config.ts` too.** Lost: they declare resources and
  provider settings, which the approval diff does not classify. They stay with the operator.
- **Let the pull-request review stand in for approval.** Lost: the reviewer may not read the contract
  diff, and the approval page shows the access change in plain language.
- **Platform-owned data language with sandboxed generated code.** Lost: a large trusted runtime that
  limits what applications can do, for an isolation property the first users do not need.
- **A faster stage build as the only loop.** Kept as separate work, not an alternative: it shortens the path to stage
  and production, but a Zerops pipeline does not go below about 51 s.
- **Control pushes files over SSH or SFTP into a codeless service** (Zerops' own agent workflow). Lost: Control cannot
  reach a namespace without a VPN client and a new key, a codeless service breaks ADR-0043's refusal of
  `startWithoutCode`, and that workflow gives the agent an operator token.
- **`zops deploy` of a prebuilt artefact.** Lost: 21–43 s per deploy, and Control has no builder on Zerops
  ([ADR-0003](0003-no-deploy-runner-on-zerops.md)).
- **An agent in the container that Control pushes to over a public route.** Lost: a second public route beside the
  proxy, which ADR-0022 refuses with no approval path.
- **`fabrika app dev` run remotely.** Lost: its stand-in IAM issues tokens, and the proxy admits no credential-less
  caller (ADR-0022, ADR-0035).
- **The authoring stage environment itself as the dev environment.** Lost: a workspace would no longer show its checked
  build before the pull request.
- **One pinned Zerops service per `dev` environment, bound to one workspace at a time.** Lost: one workspace at a
  time, a switch reset the schema, a start from idle took about 9 s, and the service took one of a `zerops-subdomain`
  namespace's six proxy hosts.
- **A Zerops service per workspace.** Lost: a bootstrap would wait for a Zerops pipeline (at least about 51 s), and a
  namespace project would hold a service per workspace.
- **A PostgreSQL service in the namespace for the sandboxes.** Lost: a sandbox in the `INTERNET` network mode reaches
  no sibling service of the project, and a database inside the sandbox makes `reset_dev` local to its workspace.
- **Box's own workspace secrets, or its launch environment, for the credentials.** Lost: a per-sandbox Box secret is an
  alias of a variable of the `zbox` service, so each sandbox's credentials would be service variables Fabrika writes
  through the Zerops API and removes with the sandbox, and any sandbox-scoped Box token can deliver them; the launch
  environment is not limited to the launcher. The root-only file the deploy writes needs neither.
- **Install dependencies in the long-lived container on a lockfile change.** Lost: a build step would run outside the
  checked build; a lockfile change takes a bootstrap run instead.
- **Commit through GitHub's GraphQL `createCommitOnBranch`.** One mutation instead of the blob, tree, commit and ref
  calls would save about 2 s per `apply_changes`. Lost: it cannot set the author, so the commit would name the GitHub
  App instead of the person who made the change. Authorship matters more than the 2 s.
