---
id: 0049
title: Author applications through an MCP endpoint in Control over Git workspaces
status: accepted
date: 2026-10-07
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
6. **Repository configuration is protected.** Control refuses edits to `zerops.yaml` / `zerops.yml`
   at any depth, `fabrika.*` files and everything under `.github/`; the operator changes them through
   normal review.
7. **Production is not an MCP operation.** The tool opens a pull request. A human reviews and merges
   in GitHub, and the existing Delivery trigger deploys the merged commit.
8. **Zerops only** for this version.

## Consequences

- One service owns authoring authorization; no delegation tokens, journal or second database.
- Control gains the MCP SDK dependency and a second user protocol.
- MCP cannot scale separately from Control.
- Concurrent edits are serialized by the expected head; there is no automatic rebase.
- A stage environment shows one workspace at a time. Per-workspace previews are future work.
- The application owns its data and data authorization; the platform does not isolate generated code
  from the app's database.

## Alternatives considered

- **Separate MCP service with IAM token delegation.** Lost: a token exchange and journal write per
  call, authorization in two places, another service and database to operate.
- **Separate MCP gateway forwarding a multi-audience token.** Lost: token passthrough to Control RPC,
  which the MCP specification warns against, and a weaker audience check in every verifier.
- **Platform-owned data language with sandboxed generated code.** Lost: a large trusted runtime that
  limits what applications can do, for an isolation property the first users do not need.
