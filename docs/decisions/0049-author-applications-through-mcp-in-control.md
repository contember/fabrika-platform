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

## Decision

1. **Control serves MCP at `/mcp`** (Streamable HTTP). Each tool calls a Control use case. MCP is a
   user-facing protocol adapter beside the RPC, like webhooks and auth callbacks; ADR-0041's single
   administrative transport is unchanged. Only the Bun/Zerops composition mounts it.
2. **IAM is the OAuth 2.1 authorization server.** Authorization code with S256 PKCE, explicit RFC 8707
   resource, refresh rotation and revocation. Clients are operator-registered Client ID Metadata
   Documents (Claude, ChatGPT); there is no open dynamic registration. An access token is minted for
   one resource of one app. Its permissions are the user's live grants narrowed by the consented
   scope. No token delegation exists.
3. **The proxy enforces it** with an `oauth` gate kind and serves the RFC 9728 resource metadata.
   ADR-0022 holds: Control verifies the injected token for the resource profile and evaluates no gate.
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

Built (work unit B6): a workspace may edit `fabrika.contract.ts`, and every other `fabrika.*` file stays
protected; a widening it brings to a protected environment parks the run, and `get_deployment` reports it
with the approval link.

## Consequences

- One service owns authoring authorization; no delegation tokens, journal or second database.
- Control gains the MCP SDK dependency and a second user protocol.
- MCP cannot scale separately from Control.
- Concurrent edits are serialized by the expected head; there is no automatic rebase.
- A stage environment shows one workspace at a time. Per-workspace previews are future work.
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
