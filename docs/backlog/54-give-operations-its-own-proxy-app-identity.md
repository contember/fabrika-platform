---
id: 54
title: Give Operations its own proxy app identity
blocked-by: []
---

# 54 — Give Operations its own proxy app identity

**Summary.** On Cloudflare the Operations proxy entry uses `appId: 'vozka'`. A single
shared platform proxy — the Zerops shape, and the local stack — cannot do that, because
`parseProxyManifest` refuses a duplicate app id. So the two compositions disagree about
who Operations is, and the token minted on the Operations host carries an audience
Operations does not accept.

## Problem

`OPERATIONS_AUTH_APP_ID` is `'vozka'`, so Operations verifies tokens whose `aud` is
`vozka`. On the shared proxy the Operations entry must be `id: 'operations'`, so the
proxy mints `aud: 'operations'` for that host and Operations rejects it.

Inert today: Operations 404s every operator route on its public host, so the `/api/*`
rules in `OPERATIONS_PROXY_GATES` are never the thing that lets a request through — the
console reaches Operations through control's transport-only gateway instead. It becomes
real the moment the operator API is served on the Operations host, which is what those
gate rules are for.

The dead rules are the worse half: a gate list that would not work if it mattered reads
as though it does.

## Approach

Decide what Operations _is_ to IAM — its own app with its own vocabulary, or a surface of
`vozka`. Then make both compositions say the same thing, and either wire the public
operator route or delete the gate rules that pretend it exists.

## Acceptance

The Cloudflare and shared-proxy compositions mint the same audience for the Operations
host, Operations accepts it, and no gate rule describes a route that cannot be reached.

<!-- Origin: sprint auth-hardening, 2026-08-04, WU-D. -->
