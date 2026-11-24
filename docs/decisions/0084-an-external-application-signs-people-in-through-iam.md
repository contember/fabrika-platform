---
id: 0084
title: An external application signs people in through IAM and receives their roles there
status: accepted
date: 2026-11-24
---

# 0084 — An external application signs people in through IAM and receives their roles there

## Context

Some applications run outside the installation and are not behind its proxy. An operations tool is the first. They
want the installation's people, signed in once, and they want IAM to say who may do what in them. IAM serves them
through the OAuth authorization server of [ADR-0049](0049-author-applications-through-mcp-in-control.md), as a
managed client of kind `external`. That server mints a token for a registered resource with the person's permissions
there. The only resource it serves managed clients is the console's `/mcp`, so an external client used to receive an
authoring token: write access to workspaces and deploys to stage. An application that only signs people in must never
hold that.

Data access is the application's own business: which projects or accounts a person sees there stays in the
application. What it needs from IAM is the person, and the person's role in the application.

## Decision

1. **An external client is bound to an identity resource of its own.** The operator registers the client, in the
   same client list as every managed client, with `identity: { app, resource, roles? }`. `resource` is an `https` URI
   of the application, never one on a platform host or a registered resource. `app` is an id of the application in IAM:
   lowercase, no `@`, and not a platform audience or a registered resource's app. The binding lives on the client,
   so a bound client is served that resource alone, with the one scope `identity`. A grant it held for another
   resource before it was bound mints nothing. Both clouds read the list from `FABRIKA_PLATFORM_MCP_CLIENTS_JSON`.
   A Cloudflare installation supports identity-bound external clients. It does not support MCP authoring yet, so its
   deploy refuses any other entry as not supported yet, before it deploys anything.
2. **Its token names the person and carries no permission.** `sub`, `label`, `ptype: user` and `email`, for
   `aud` = the resource and `app` = the id. `perms` is always empty, at the code exchange and at every refresh. No
   installation service or application accepts the token, because none has its audience.
3. **The application's roles are IAM's to grant and the token's to name.** `roles` is a list of `{ key, name }`. The
   deploy reconciles them into IAM as the application's vocabulary, each role granting no action, with the
   provisioning key it already holds (on Cloudflare, the control-plane stage, after IAM's own vocabulary). So the application needs no IAM credential, and an administrator grants the
   roles in the console like any application's. The token carries the keys of the roles the person holds globally at
   the application (`roles`). The application decides what each role allows.
4. **With declared roles, no role means no sign-in.** The consent and the code exchange refuse a person holding no
   declared role (`access_denied`, `invalid_grant`). Every refresh resolves the roles again, so a removed role ends
   the sign-in within one token lifetime (300 s), and the token never outlives the grant of a role it names. An
   external principal ([ADR-0051](0051-external-principals.md)) holds none: it holds only membership roles its
   application declares external. Without `roles`, every active user signs in and the token names no role.

**Invariant:** A token for an identity resource carries no permission, and IAM serves an identity-bound client no
other resource.

## Consequences

- An external application gets single sign-on and role-based access without an IAM credential, and without the
  authoring reach of `/mcp`.
- A role is a name. An application that needs finer rules keeps them itself; IAM does not learn its data.
- A list of identity-bound clients alone leaves MCP authoring off: no `/mcp` row, no authoring resource. That is
  why a Cloudflare installation, which does not support MCP authoring yet, can register them.
- `roles` is an additive claim of a resource token. A parser that predates it ignores it. `email` was already a user
  token's claim.
- **Rollout.** No generated file changes. `fabrika platform deploy` rewrites `FABRIKA_IAM_OAUTH_CONFIG` as before;
  it gains a binding only when the operator adds one to `FABRIKA_PLATFORM_MCP_CLIENTS_JSON`, and it reconciles the
  application's roles on every deploy. Removing a role from the list removes it from IAM at the next deploy, and the
  role's grants then name nothing; dropping `roles` altogether stops the reconcile and leaves the last roles in IAM,
  unnamed by any token. Adding `roles` to a client that signed everyone in refuses everyone until an administrator
  grants the roles, so grant them right after that deploy. An IAM from before the binding refuses the key and stops at boot, so rolling `iam`
  back first removes the entry and deploys.
- **Rollout on Cloudflare.** The scaffolded `platform.yml` passes `FABRIKA_PLATFORM_MCP_CLIENTS_JSON` from the GitHub
  Environment to the IAM stage, which writes it into IAM's `OAUTH_CONFIG` after checking it with IAM's own boot
  parser, and to the control-plane stage, which reconciles the roles. An existing installation gets the new workflow
  when it bumps `fabrika.ref` and regenerates `platform.yml`; until the operator sets the variable, nothing changes.
  A workflow that predates it never passes the variable, so its deploys register no client. Removing the variable
  removes the clients from `OAUTH_CONFIG` at the next deploy. `OAUTH_CONFIG` is a plain Worker variable, capped at
  5,120 bytes, so the list fits a few clients, not IAM's ceiling of 16.

## Alternatives considered

### An identity resource as an entry of `resources`

Rejected. A resource entry is served to any managed client, so the client would still be served `/mcp` beside it.
Binding the resource to the client makes "this client gets only this" one fact.

### Roles as actions in `perms`

Rejected. The token would then carry permissions, and anything that took it for a platform token would read them as
authority. A role name grants nothing by itself.

### The application uploads its roles with an IAM key

Rejected. The application would hold an administrative credential of the installation. The deploy already holds the
provisioning key and reconciles every installation vocabulary.

### OpenID Connect ID tokens

Deferred. The access token already names the person for the one audience that reads it; an ID token adds a second
token kind and discovery without a current caller.
