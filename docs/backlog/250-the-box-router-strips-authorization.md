---
id: 250
title: The Box router strips Authorization before a dev sandbox
blocked-by: []
---

# 250 — The Box router strips Authorization before a dev sandbox

**Summary.** The Zerops Box router drops `Authorization` on every request, so a dev sandbox's application never sees
it: a key caller's non-`GET` request fails admission and a webhook verified by a bearer or basic credential fails. It is
an accepted limitation today; this item is the designed workaround. Medium.

## Problem

The proxy replaces a key caller's `Authorization` with `Bearer <minted token>`, and the application tells a bearer from a
session by the header's presence ([ADR-0022](../decisions/0022-the-proxy-is-the-only-enforcement-point.md) rule 3). A
webhook row with `authorization: 'forward'` keeps the caller's `Authorization` for the application to verify. Behind
the Box router ([platform facts](../reference/zerops-platform.md)) the header never arrives, so in a sandbox both read
as no credential ([MCP authoring](../reference/mcp-authoring.md#inside-a-sandbox)).

## Approach / acceptance

On a dev sandbox entry only, the proxy sends the value it would send as `Authorization` under a hop header of its own
(added to `FABRIKA_HOP_HEADERS`, so a client cannot set it), and the dev launcher's front of the application moves it
back to `Authorization` before the request reaches application code. Nothing changes for any other entry. Test: in a
live Caddy and the launcher, a `px_` key's `POST` and a bearer-verified webhook reach a sandbox's application with
`Authorization`.

## Touch points

- `packages/proxy/src/caddy.ts`
- `packages/auth-core/src/` (the hop header list)
- `packages/app/src/dev/launcher.ts`
