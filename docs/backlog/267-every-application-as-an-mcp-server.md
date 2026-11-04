---
id: 267
title: Every contract application as an MCP server
blocked-by: []
---

# 267 — Every contract application as an MCP server

**Summary.** The proxy serves `/mcp` on an application's host, with tools generated from the contract's declared
procedures and the same OAuth as the console's MCP. A bold bet; large. An installation-wide decision on which
application data may reach external models comes first.

## Problem

People increasingly work through Claude or ChatGPT. An internal application is reachable only through its SPA, so an
assistant cannot read or change its data on the person's behalf, even when the person may.

## Approach / acceptance

The contract already declares endpoints with input schemas, callers and requirements
(`packages/auth-core/src/contract.ts`), the proxy already enforces them
([ADR-0022](../decisions/0022-the-proxy-is-the-only-enforcement-point.md)), and IAM already issues MCP-grade OAuth for
Control ([ADR-0049](../decisions/0049-author-applications-through-mcp-in-control.md): RFC 9728 metadata, a resource-bound
`at+jwt`). An application opts endpoints in (for example `mcp: true` on a procedure); the opt-in is part of the approved
access, so the approval diff shows "now callable by agents"
([ADR-0050](../decisions/0050-approved-access.md)). Tool annotations follow from method and actions. Each call is an
ordinary request through the proxy's one enforcement decision.

The token is the unsolved part. Caller `oauth` is installation-only (`packages/auth-core/src/installation-endpoint.ts:11`),
and an application's verifier refuses a resource token (`packages/auth-core/src/token.ts:280`). The design must say how
the proxy turns an MCP client's OAuth authority into the application's own token (for example, IAM exchanges the
resource token for an ordinary application token, as the proxy's session handoff does) while the proxy keeps the one
enforcement decision. That is an additive change to the application↔platform protocol
([ADR-0062](../decisions/0062-a-platform-release-serves-older-framework-releases.md)): a framework capability that an
older application lacks, so only applications on a new enough release can opt in.

Before any code: an ADR on the installation policy for application data reaching a third-party model (which
applications may expose MCP, who decides, whether a person's consent names the model). Open: tool count on an
application with about 100 endpoints, and human-written tool descriptions in the contract.

Acceptance: an opted-in procedure appears as a tool to an MCP client signed in through IAM, a call runs under the
person's grants with no new enforcement path, and an endpoint that is not opted in is not listed and not callable as a
tool.

## Touch points

- `packages/auth-core/src/contract.ts`, `packages/proxy-core/`, `packages/proxy/`
- `packages/iam/` (OAuth resource per application host)
- `packages/control/src/approval/`

<!-- Origin: feature ideas review, 2026-11-02. -->
