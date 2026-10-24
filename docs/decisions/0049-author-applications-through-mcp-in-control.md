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
   to `zerops.yaml` / `zerops.yml` at any depth, `fabrika.*` files and everything under `.github/`; the
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
10. **An application may have one `dev` environment.** A commit to the workspace bound to it reaches the running
    service through the dev launcher, without a run. `deploy_stage` stays the only path to a checked build.
    Per-workspace environments are future work.
    - An operator registers it with kind `dev` (`apps.environments.put`). It is never production, never protected
      (ADR-0050), never an authoring target and has no trigger ref; it has its own service, schema, role family, proxy
      host and approved access. The proxy stays its only ingress (ADR-0022 unchanged).
    - `bind_dev` binds a workspace of the app's authoring environment to it. A bind starts a **bootstrap run** (an
      ordinary run of the workspace head with the full build and every check) whenever the running launcher cannot
      serve the workspace: the first bind, after a failed bootstrap or a refused sync, when the paths from the head the
      container holds to the workspace head change something the build owns, and when the launcher is gone. It is gone
      when Control cannot read its requests (an older or newer wire), or when it sent none for longer than it ever
      waits (90 s; 15 min while it syncs or runs the checks); after a start from idle, `bind_dev` waits up to 15 s
      for its first request. Such an environment is `needs_bootstrap`, and `apply_changes` does not wait for it. Its provider starts the dev launcher instead of the serving entry
      ([ADR-0043](0043-validate-and-render-one-zerops-descriptor-meaning.md)). Binding another workspace syncs its
      tree and resets the schema.
    - The launcher holds a long poll on Control's public origin with a `source` workload key
      ([ADR-0064](0064-applications-reach-the-platform-over-a-receiver-verified-transport-key.md)). Control answers
      with the changed files of the bound head: the files `apply_changes` just wrote, handed over in memory, or else
      read from a GitHub compare. A container of a replaced bootstrap run is refused (409), so it cannot report over
      the new one. Control stores the record of
      the environment (bound workspace, target and served head, status, time, a trimmed log), never file contents
      (rule 4 holds).
    - The launcher writes the files, migrates when `db/migrations/` changed, runs the authored SPA build when a web
      source changed, respawns the application (not `bun --watch`, so it knows when the new head serves), and reports
      `{ head, status, last log lines }`. A commit that changes something the build owns (`package.json`, `bun.lock`,
      the build descriptor, generated files, which covers the framework pin) is refused in one line: it needs a
      bootstrap run. So is a commit that changes the contract: after writing the files, a child of the launcher with no
      credential computes the contract digest, and a digest other than the bootstrapped `FABRIKA_CONTRACT_DIGEST`
      restores the files and refuses the commit. The digest decides, not the paths: an edit of a handler in a module
      the contract imports syncs, and the proxy table and the approval, which follow the digest, stay true. At boot the
      launcher reconciles to the recorded head before it serves.
    - `run_checks` is refused while the container holds another commit than the workspace's newest, and its results
      name the commit they checked.
    - `apply_changes` on a bound workspace waits up to 10 s for that report and returns
      `dev: { head, state, summary, url, log }`, or the pending state on a timeout. `get_dev_status` reads the rest.
    - `run_checks` runs the build's check chain (tests, `fabrika-check`, `tsc`) in the container on request. It
      gates nothing. `reset_dev` drops and recreates the environment's role family and schema and migrates from
      scratch. `bind_dev`, `run_checks` and `reset_dev` need `deploy.trigger`; `get_dev_status` needs `deploy.read`.
    - Control stops the service after 30 minutes with no sync; the next `apply_changes` or `bind_dev` starts it.
    - Nothing from a `dev` container is promoted. A commit reaches stage and production only by its own build.

Built (work unit B6): a workspace may edit `fabrika.contract.ts`, and every other `fabrika.*` file stays
protected; a widening it brings to a protected environment parks the run, and `get_deployment` reports it
with the approval link.

## Consequences

- One service owns authoring authorization; no delegation tokens, journal or second database.
- Control gains the MCP SDK dependency and a second user protocol.
- MCP cannot scale separately from Control.
- Concurrent edits are serialized by the expected head; there is no automatic rebase.
- A stage environment shows one workspace at a time, and so does a `dev` environment. Per-workspace environments are
  future work.
- A `dev` environment serves a commit about 1–2 s after `apply_changes` instead of after a 2–4 minute build. What it
  serves skipped the checks; `run_checks` and `deploy_stage` are how an agent learns whether the head passes them.
- A `dev` environment costs one container per application, pinned to one container, one schema, and one proxy host of
  the six a `zerops-subdomain` namespace publishes. A bootstrap takes a namespace lease
  ([ADR-0044](0044-zerops-delivery-ownership-and-recovery.md)); a sync is not a Zerops operation and takes none.
- The dev container holds what a stage container holds, plus the `source` key. Unreviewed code there can read that key,
  which reads only source the code already runs.
- Rollout: an existing installation needs no operator step. Control's migration adds the environment kind (default
  `standard`) and the record on start. The console's proxy table gains the `dev-source` row, so its digest changes, and
  `platform upgrade` republishes it like any table change. An application gets a
  `dev` environment only when an operator registers one and its framework release ships the launcher
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
- **Install dependencies in the long-lived container on a lockfile change.** Lost: a build step would run outside the
  checked build; a lockfile change takes a bootstrap run instead.
- **Commit through GitHub's GraphQL `createCommitOnBranch`.** One mutation instead of the blob, tree, commit and ref
  calls would save about 2 s per `apply_changes`. Lost: it cannot set the author, so the commit would name the GitHub
  App instead of the person who made the change. Authorship matters more than the 2 s.
