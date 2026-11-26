---
id: 0090
title: A device grant reaches an application as the person, narrowed to one scope value
status: accepted
date: 2026-11-26
---

# 0090 — A device grant reaches an application as the person, narrowed to one scope value

## Context

An agent or a script that calls a deployed application holds a `px_` key, because no other credential reaches an
application row. The device grant ([`cli-device-grant.md`](../reference/cli-device-grant.md)) is narrow, short,
approved in the browser and revocable, but it reaches Control and Operations only. There are three reasons:

- IAM serves only the console's resources.
- The proxy verifies an OAuth bearer only on installation rows ([ADR-0022](0022-the-proxy-is-the-only-enforcement-point.md),
  "Principal kinds").
- The framework presents an OAuth token as no caller.

A key either carries the person's whole live authority at the application for up to 30 days, or belongs to a service
principal that no person is accountable for.

The design [`agent-login-into-applications.md`](../specs/agent-login-into-applications.md) settles how such a grant
reaches an application: an exchange at the proxy, the caller `agent`, and the scopes `read` and `write`. It leaves one
question open, a grant narrowed to one value of a dimension. That question matters most for an agent that works on
one project of a multi-project application: with the person's whole set it reads and changes every project the person
can.

[ADR-0089](0089-oauth-clients-are-registered-in-iam-at-runtime.md) left per-application OAuth resources to a later
decision. This is that decision. It needs no client row: the command-line agent client is built in, as `fabrika-cli`
is.

## Decision

### 1. An application environment is an OAuth resource, served to the built-in client `agent-cli`

The resource is the environment's origin, `https://<host>`. IAM resolves it through the return origins Control already
registers for `<app>@<env>`. It is a resource only while the environment's approved schema admits the caller `agent`,
which the schema reconcile records. An origin registered for two ids, or for none, is `invalid_target`.

`agent-cli` is public, has no secret, uses the device and refresh grants only, and is served application resources
alone. `fabrika-cli` keeps Control and Operations. Neither client reaches the other's resources.

The proxy serves RFC 9728 metadata at `/.well-known/oauth-protected-resource` on such a host, and a refused bearer
carries the `resource_metadata` challenge. The spec's shared client profile (discovery, RFC 8628, rotating refresh,
RFC 7009) is the client's whole contract.

### 2. The scope is `read` or `write`, optionally narrowed to one value: `read:<dimension>=<value>`

A grant holds exactly one scope token. It is one of the following, and the device page shows its meaning in words:

| Scope token                 | Endpoint kinds it admits                  | Permissions at each exchange                            |
| --------------------------- | ----------------------------------------- | ------------------------------------------------------- |
| `read`                      | `query`, `download`                       | the person's live set                                   |
| `write`                     | `query`, `mutation`, `upload`, `download` | the person's live set                                   |
| `read:<dimension>=<value>`  | as `read`                                 | the person's live set narrowed to `<dimension>=<value>` |
| `write:<dimension>=<value>` | as `write`                                | the person's live set narrowed to `<dimension>=<value>` |

No scope admits an `spa` row. `read` is the default when the client asks for none.

A narrowed scope has the following rules:

- The dimension must be one the environment's approved schema declares. IAM checks it at the device start
  (`invalid_scope`) and again at every exchange. The value is opaque: IAM never checks that it exists (ADR-0022 rule 6).
  The value holds only characters an OAuth scope token admits, and is bounded like a grant's scope value.
- The device page names the dimension and the value. Where the dimension lists values
  ([ADR-0085](0085-a-grant-holds-a-set-of-scope-values.md)), the page also shows the value's label; otherwise it says that
  nothing checks the value.
- The person may approve a narrower grant than the agent asked for, never a wider one: `write` may become `read`, and
  the narrowing can be neither dropped nor changed.
- The narrowing is part of the grant row (`oauth_grants.scopes`) that the person approved. IAM reads it from there at
  every exchange, never from the request or from the token the agent holds.

### 3. The proxy exchanges the grant for the person's application token, narrowed

The exchange works as the spec describes:

1. On a row that lists `agent`, the proxy verifies a non-`px_` bearer locally as a resource token of this host.
2. Only then does it call IAM's `mintFromGrant`, on the mint surface beside `mintFromKey`. The call is refused over an
   application Worker's binding.
3. IAM checks the grant's authority (live, not revoked, the approving login usable, an active user). It resolves the
   person's live permissions at `<app>@<env>` and applies the narrowing below.
4. IAM mints an ordinary application token: `ptype: 'user'`, the person's identity, those permissions, and
   `act: { sub: 'agent-cli', grant, label?, scope }`. It expires at the earliest of 300 s, the resource token's expiry and
   the authority deadline.

`callerOf` maps a user token that carries `act` to the caller `agent`. The scope admits endpoint kinds by the table
above, in the proxy's decision and again in the framework.

**The narrowing.** For a grant narrowed to `D=v`, each of the person's live entries becomes:

| Entry the person holds                                                      | Entry the token carries                              |
| --------------------------------------------------------------------------- | ---------------------------------------------------- |
| global (`scope: null`)                                                      | the same action at `D=v`                             |
| at `D=v`                                                                    | unchanged                                            |
| a relation held anywhere (`~rel`, ADR-0073)                                 | the same relation held inside `D=v` (`~relin r:D:v`) |
| a relation held inside `D=v` (`~relin r:D:v`)                               | unchanged                                            |
| at any other value of `D`, at any other dimension, any other `~relin` entry | dropped                                              |

The rule is one function in `@fabrika/auth-core`, used by IAM and by the test kit's stand-in IAM. It never adds an entry
the person does not hold and never widens a scope. An entry at a container of `D=v`, or at a node inside it, is
dropped, because IAM does not know which values lie in which: containment is application data. A person whose access
to `v` comes only through such a grant gets a token that reaches nothing. They need a grant at `v` itself or a global
one, and the device page shows the narrowed actions before they approve.

**Invariant: a narrowed token carries no entry outside its value.** Every entry is global-turned-`D=v`, at `D=v`, or a
relation inside `D=v`. Nothing outside the value is left for the proxy or the framework to read.

### 4. Isolation: a token narrowed to project A reaches nothing in project B

Every check that could reach B reads only the token's entries, so it fails for B:

- **The proxy.** An `app` row and an `anyOf` row need the action held as a global grant, and the token holds none: 403.
  An action row needs the action in some scope, so it passes. What it reaches is decided below.
- **The framework's access forms.** They read the token's entries alone:
  - `in` with project B: no entry at B or at a container of B, so 403.
  - `on` with an object in B: the chain names B and no entry matches, so 404.
  - `over`: the `Within` holds A only, and the data layer matches each row's key or chain to A in the same statement.
- **Relations.** A relation entry holds only inside A (`~relin`), and the data layer re-reads the relation rows per
  statement, so a relation row in B counts for nothing.
- **IAM's own writes.** A membership, link or delegation operation holds the caller to the token's entries intersected
  with its live permissions (`resolveMemberCaller`), so it acts in A or nowhere. `createScope` needs the action as a
  global entry, which a narrowed token never carries, so it creates no new top-level value. A `read` token is refused
  every IAM write, as the spec says.
- **Re-narrowed at every exchange.** A grant the person gains in B later is dropped at the next exchange, as is
  everything else outside A.

What the narrowing does not cover is what no token decides: a site that declares `unscoped` or `sql` reaches what it
declares for every caller, and the approval diff shows those declarations. An `agent` caller gets such a site only on
a group whose callers list `agent`.

The witness is a test that holds both halves. A token narrowed to project A calls a query and a mutation in A and gets
answers. The same calls in project B get 403 or 404, and a list over projects returns A's rows only. It runs through
the test kit, which uses the production proxy decision and `boot`.

### 5. What stays as the spec decides

Several parts follow the spec unchanged:

- `ctx.agent`, the audit actor columns and the IAM grant records with the agent's label;
- the `read` refusals of IAM writes and the token lifetimes (the grant up to a week and never past the approving
  login; an access token 300 s);
- the rollout across proxy releases.

The spec's two later steps, the `agent-write` category of protected environments and the person's own grant list,
follow this decision. Until the `agent-write` mirror exists, IAM serves `read` grants only at an environment it holds
no mirror for. The absence fails closed.

**ADR-0022, changed.** An OAuth resource token still reaches no application endpoint as a bearer. What reaches the
application is the token the proxy exchanges it for, and only on a row that lists `agent`. ADR-0022's "Principal
kinds" says so.

## Consequences

- An agent works on one project with a grant a person approved in the browser, revocable within 300 s. It needs no
  service key and no machine-only group.
- The application keeps every authorization check it runs for the person. The narrowing only removes entries, so
  nothing the person cannot do becomes possible.
- A person who reaches a project only through a container grant (an organisation's role) gets nothing from a grant
  narrowed to that project. Granting them a role at the project, or approving an unnarrowed grant, are the ways out.
  The device page shows the narrowed actions, so they see it before approving.
- A grant names one resource and one scope. An agent that works on two projects holds two grants. Its credential
  helper keys its refresh tokens by origin and scope, an addition to the spec's custody step.
- **Rollout.**
  - The narrowing adds no column: the scope token is stored in `oauth_grants.scopes` as every scope is. The spec's
    migrations (the grant's label, the audit actor columns, the mirror) are additive.
  - No generated file or environment variable changes. An application that does not declare `agent` is served
    exactly as before.
  - A framework release that declares `agent` needs a platform release that knows it. Control reads the contract with
    its own release's artifact schema, which refuses an unknown caller, so the declaration never reaches an older proxy
    (ADR-0062). On Zerops a namespace proxy pinned to an older source refuses the deploy, and the message names the
    re-pin. On Cloudflare the proxy Worker ships with the environment's deploy.

## Alternatives considered

- **The application declares an `oauth` caller with its own scopes, and IAM registers per-application resources and
  scope ceilings at deploy.** The resource token would reach the application as its credential, so the framework
  would verify a second token shape and the scope ceilings would be a second vocabulary beside the roles. The exchange
  gives the application the person's ordinary token, and the scope removes only endpoint kinds.
- **A set of values (`read:project=A,B`).** It would be one grant for an agent that works on several projects, but each
  value multiplies token entries and the device page's explanation. One value covers the case that motivated this
  decision. A set can be added later as a scope form.
- **Narrowing a container grant to the value when the value lies inside the container.** IAM would need the
  application's containment data, or would have to trust the agent's word that A lies in the organisation. Dropping
  the entry fails closed.
- **The person picks the value on the device page instead of the agent asking for it.** The page would need the
  application's values for every dimension, which only a value source procedure answers (ADR-0085 §4), and the agent
  would not know what it got until it calls. The agent names the value; the page shows it, with a label where the
  dimension lists one.
