---
id: 253
title: A dev environment registered before sandboxes lingers half-served
blocked-by: []
---

# 253 — A dev environment registered before sandboxes lingers half-served

**Summary.** Until the operator deletes and re-registers it, a `dev` environment registered for the one-service design
keeps its old proxy entry, and an MCP author who binds it gets a generic failure instead of the remedy. Small.

## Problem

1. **The author does not see the remedy.** The Zerops provider refuses a dev environment whose stored target names its
   own Zerops service, saying to delete it and register it again with `--kind=dev` and a wildcard domain
   (`sandboxHostOf`, `packages/provider-zerops/src/control.ts`). It throws a plain `Error` from inside `bind_dev`'s
   `ensureDevSandbox` (`packages/control/src/api/dev-environments.ts`), so the MCP answer is the generic failure with a
   reference; only Control's log holds the message.
2. **Its old entry stays routed.** `namespaceMembers` (`packages/control/src/api/namespaces.ts`) hands a `dev` member
   without sandbox rows like any other member: its domain, its artifact's upstream, its proxy secret and its approved
   access. The namespace proxy therefore keeps routing the old dev service's host until the operator deletes the
   environment ([MCP authoring](../reference/mcp-authoring.md#upgrading-an-installation-with-a-dev-environment)).

## Approach / acceptance

1. Raise the refusal as an answer the author reads: a typed provider error that `bind_dev` maps to a 409 with the
   operator's remedy. Test: `bind_dev` on an environment with an old stored target answers 409 naming the re-registration.
2. Decide whether a `dev` member without sandboxes contributes any entry. Dropping it stops routing the old service
   before the operator acts; keeping it serves the old service until then. Test: whichever is decided, a namespace
   job with such a member hands it as decided.

## Touch points

- `packages/provider-zerops/src/control.ts`
- `packages/control/src/api/dev-environments.ts`
- `packages/control/src/api/namespaces.ts`
