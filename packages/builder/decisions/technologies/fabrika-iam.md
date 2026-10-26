---
id: fabrika-iam
kind: technology
title: Fabrika IAM — native login, authorization and audit
slot: authz
provides: [authentication, sso, authorization, audit, api-tokens]
requires: [cloudflare, d1]
recommends: [fabrika-control, buzola]
conflicts: [cloudflare-access, auth-password-kv]
npm: ["@propustka/client@^0.0.6", "@propustka/core@^0.0.6"]
status: wip
sources:
  - where: "the predecessor IAM repository — README.md, architecture.md, packages/core/src/, packages/worker/src/"
    read: "Native session/login architecture, app gates, token/JWKS contract, central human identity and D1 policy/audit model."
  - where: "@propustka/client (installed packages/client/src/{session,client,fake,types}.ts)"
    read: "The current PropustkaAuth, AuthContext, AppGates, setCookie/loginUrl and FakeIamClient surfaces. Version 0.x moves quickly; read the source."
  - where: "the predecessor IAM examples"
    read: "Runtime gates, local operator context, SSO redirects, response cookies, schemas, and IAM bindings."
---

# Fabrika IAM

## What it is

The native identity, authorization and audit service for Cloudflare Workers apps.
There is **no Cloudflare Access edge** in front of a native Fabrika IAM app.
Fabrika IAM owns human SSO sessions, per-app permission tokens, `px_` service keys,
authorization policy and audit logs.

An app integrates over an `IAM` Worker-to-Worker service binding and uses
`PropustkaAuth` as its single request-auth seam. `PropustkaAuth` applies ordered
per-path gates, verifies cached permission JWTs locally against Fabrika IAM's JWKS,
and only calls the binding when it must exchange a session/key or write audit.

## When & why to use

- An internal Cloudflare app needs human login plus role/scope-based permissions.
- The same API supports logged-in people and `px_` service credentials.
- You want a central people directory, app-defined roles/scopes, revocable keys
  and an audit trail.
- The target Cloudflare account already runs Fabrika IAM (normally alongside Fabrika Control).

## When NOT to use

- The app is not a Cloudflare Worker; the integration is a service binding.
- There are no real authz/audit needs and a central IAM dependency is unjustified.
- The product requires app-owned signup/password recovery; use a product auth
  system instead.
- Strict hierarchical scopes are fundamental. Fabrika IAM scope dimensions are
  flat; containment must be resolved by the app.

## Runtime integration

```ts
import type { AppGates, IamRpc } from '@propustka/client'
import { PropustkaAuth } from '@propustka/client'

const gates: AppGates = {
	rules: [
		{ path: '/rpc', kind: 'service' },
		{ path: '/rpc', kind: 'human' },
	],
}

const result = await new PropustkaAuth(env.IAM as IamRpc, APP_ID, {
	issuer: env.PROPUSTKA_URL,
	gates,
}).authenticate(request)

if (!result.ok) {
	return Response.json(
		{ error: { message: result.reason, loginUrl: result.loginUrl } },
		{ status: result.status },
	)
}

if (!result.context.can('site.write', { type: 'site', value: siteId })) {
	return new Response('Forbidden', { status: 403 })
}

ctx.waitUntil(result.context.audit({
	action: 'site.write',
	resourceType: 'site',
	resourceId: siteId,
}))
```

When `result.setCookie` is present, append it to the outgoing response. It is the
short-lived per-app `px_token`; dropping it forces repeated session exchanges and
can make login appear broken.

## Gates and login behavior

- `AppGates` are **runtime code**, not deploy-time schema. They replaced
  Cloudflare Access policies and are passed directly to `PropustkaAuth`.
- Rules are ordered. A common protected path has `service` first and `human`
  second, so a present service key is terminal while a missing key falls through
  to the browser session.
- A `public` rule creates an anonymous context. A path matching no rule is denied
  (`no_rule`) — native auth is fail-closed.
- A human miss includes `loginUrl`. The SPA should redirect there and set its
  return URL to the current page, with a short bounce guard so an unprovisioned
  identity does not loop forever.

## Authorization model

- Keep action ids, scope dimensions and the app id as shared constants. Runtime
  `can()` checks and Fabrika Control's `AppSchema` must use the same vocabulary.
- `can(action, scope?)` and `scopedTo(action, dimension)` are local pure checks on
  the minted permission set. `scopedTo` returns `null` (all), `[]` (none), or an
  exact list.
- Audit is the operation that reaches the binding on the hot path; schedule it
  with `ctx.waitUntil`.
- The app's `schema` (actions/scopes/roles) is reconciled by Fabrika Control during deploy.

## Local development and opice

Do not require a live IAM Worker locally. An explicit `DEV` var should select a
deterministic app-local `AuthContext` for a known operator persona. Current
`FakeIamClient` covers management methods such as principal listing and key
issue/revoke; it is **not** the replacement for `PropustkaAuth.authenticate()`.

Omit the external `IAM` service binding in the local resource graph when the
local runtime cannot resolve it. Off-local, fail loudly if `IAM` or
`PROPUSTKA_URL` is missing.

## Relationships — why

- **requires `cloudflare`** — request auth and audit use a Worker service binding.
- **requires `d1`** — the separately deployed Fabrika IAM service stores identity,
  policy, sessions and audit data in D1.
- **conflicts `cloudflare-access`** — native Fabrika IAM replaces the Access edge;
  combining both creates two competing login/gate systems.
- **conflicts `auth-password-kv`** — Fabrika IAM owns login and sessions; do not add
  a parallel app-owned password session.
- **recommends `fabrika-control`** for schema reconciliation and **`buzola`** for internal
  app SPAs.
