---
id: 54
title: Move the Operations operator surface onto the Operations host
blocked-by: []
---

# 54 — Move the Operations operator surface onto the Operations host

**Summary.** Operations is meant to be its own IAM application. It cannot be while its
only authenticated surface is fronted by the CONSOLE's proxy, because the app id a
request is authorized under is the app id of the proxy that minted its token. Half of
this item shipped (the dead gate rules are gone and both compositions name the
Operations host `operations`); what is left is the move that makes the identity real.

## What already shipped

The Operations public hostname serves two `public` routes — Sentry envelope ingest and
the source-map upload — and `OPERATIONS_PROXY_GATES` now declares exactly those. The
`/healthz`, `/private/*` and `/api/*` rules described routes `app.ts`'s `isPublicIngress`
guard answers with a 404 on that host; they are denied outright now (`no_rule` → 403)
rather than admitted into a 404. Both compositions name the host by `OPERATIONS_APP_ID`,
so a shared manifest can express the Cloudflare shape, which `appId: 'vozka'` never could.

## What is left, and why it is not a rename

`OPERATIONS_AUTH_APP_ID` is still the console's app id. It is not an oversight and it is
not a one-line change:

- The operator surface is reached over the private network through control's
  transport-only gateway (`packages/control/src/operations-gateway.ts`, ADR-0016). The
  token that arrives with it was minted by the CONSOLE's proxy for the console's gate
  rules, so it carries the console's `aud` and the caller's permissions **in the console's
  app**. Flipping the constant refuses every operator request the console makes — measured,
  not inferred: on the local stack the operator RPC goes 200 → 401.
- The console cannot obtain an `operations` token instead. Since
  [ADR-0023](../decisions/0023-one-session-per-host.md) a browser's app session is
  host-only and app-bound, and `mintToken` refuses a session whose `app` is not the one
  being minted for. A browser holding a `vozka` session on the console's host can never be
  handed an `operations` token there, by design.

So the surface has to move to the host whose proxy mints `operations`. That is a console
architecture change, not a configuration one, and it needs a decision of its own:

- the console's Operations client stops going through `/operations/api/*` and addresses the
  Operations origin — which is cross-origin, so the proxy needs CORS **and** a preflight
  answered before gate matching (an `OPTIONS` carries no credential and cannot pass a
  `human` rule); or the Operations console views are served from the Operations host
  instead, which makes every call same-origin and needs no new proxy surface;
- Operations gets a real IAM registration: its own `AppSchema` declaring the three actions
  it checks (`operations.read` / `operations.triage` / `operations.manage`) over the `app`
  and `environment` scope dimensions, plus return origins — today `?app=operations` is a
  400 at IAM, because the app does not exist;
- the grants move with it. `packages/control/fabrika.schema.ts` declares `operations.*`
  inside the console's vocabulary, which is precisely the coupling being removed;
- `forwardOperationsApi` and control's `OPERATIONS` binding retire with the path.

## Acceptance

The console's operator requests are authorized under `operations`' own vocabulary,
`OPERATIONS_AUTH_APP_ID` is `OPERATIONS_APP_ID`, and no operator surface remains behind a
proxy that mints another app's audience.

<!-- Origin: sprint auth-hardening, 2026-08-04, WU-D. Re-scoped by sprint auth-track-closeout, 2026-08-05, WU-A. -->
