---
id: 0022
title: The proxy is the only enforcement point
status: accepted
date: 2026-08-05
supersedes: 0007, 0008, 0010, 0021
amended-by: 0023
---

# 0022 — The proxy is the only enforcement point

## Context

Where authorization is enforced has been decided four times, and each decision corrected the
one before it:

- [ADR-0007](0007-proxy-based-auth-enforcement.md) moved enforcement out of the in-process SDK
  and into a proxy — and retired an invariant _inside itself_ ("gates are pure SDK config… that
  invariant is hereby retired").
- [ADR-0008](0008-caddy-forward-auth-proxy.md) chose Caddy + `forward_auth` on Zerops and a thin
  Worker on Cloudflare, over one shared TypeScript auth service, and rejected a Go plugin.
- [ADR-0010](0010-gate-evaluation-stays-in-the-auth-service.md) amends 0008 after implementation
  disproved its central assumption, that gate rules would compile into Caddy route matchers.
- [ADR-0021](0021-exchange-token-session-handoff.md) replaces the shared session cookie that 0007
  and 0008 silently assumed, because `*.zerops.app` is on the Public Suffix List.

None of those four was wrong when written. Together they are unreadable: a new reader has to
replay four documents plus a retired invariant to learn one answer, and cannot tell which
sentences a later document has already withdrawn.

They also described a model that did not yet exist. Until the auth-hardening sprint, the app SDK
still carried a **complete second enforcement path** — gate evaluation, session→token exchange,
cookie writes, a login bounce — which every first-party service was actually using. That path is
deleted. For the first time the model the four ADRs describe is the model that runs, and there is
genuinely one place a request is admitted or refused.

This ADR states that model end to end. It adds no new choice except where noted; it restates the
settled result and re-statuses its four ancestors, which are kept because they hold the _why_ —
including the three verified Caddy semantics mismatches in ADR-0010, which are the reason rule 3
below exists and are not repeated here.

## Decision

**We will treat the proxy as the single enforcement point for every request to every application,
and let no other component hold a share of that job.** Five rules, in order.

### 1. Only the proxy is publicly routed; an app service is not reachable from the internet

An application service has no public address. On Zerops that is the platform default — a service
is private until you opt in. On Cloudflare the application Worker must declare no route and must
set `workers_dev: false`, and is reachable only through the `APP` service binding held by its proxy
Worker; the provider refuses to build the graph otherwise, so this is checked at authoring time
rather than trusted.

This is what makes enforcement structural rather than diligent. An app that forgets to check is
still not reachable, so "the app forgot" and "the world can reach it" stop being the same
deployment.

The IAM service stays **global** — one identity database, one audit log, one console. The proxy is
**stateless** and per deployment boundary: one per namespace on Zerops, one proxy root per app
environment on Cloudflare. Only the cold path leaves the private network; the warm path verifies a
token locally.

**Invariant: the proxy holds no state that a decision depends on.** Its token cache is best-effort
and per process; `null` (no cache) changes only how many times IAM is called, never which requests
are allowed. Never make it shared or persistent.

### 2. Caddy owns HTTP correctness and gets no vote on authorization

On Zerops the proxy is Caddy plus a loopback-bound Bun auth service answering `forward_auth`. On
Cloudflare the platform owns HTTP correctness, so a thin Worker calls the same auth service code
in-process. Caddy's job is WebSockets, streaming bodies, HTTP/2, hop-by-hop headers and timeouts —
nothing else.

Caddy's configuration is therefore a **fixed three-step chain per app**, generated at build time
and identical whatever the app's gates say:

1. **delete** the injected token header and the request-id header from the inbound request;
2. `forward_auth` to the auth service at `/verify?app=<id>`;
3. `reverse_proxy` to the private upstream.

Step 1 is load-bearing and must be a delete, not an overwrite: `copy_headers` guards each copy with
a `not vars ""` matcher, so an empty auth-response header is a no-op. Without the explicit delete a
client could present its own `X-Fabrika-Token` on a `public` path and have it reach the app, and
could choose the `X-Request-Id` that lands in IAM's `auth_log` and `audit_events`. **A header a
client can set never reaches a decision.**

Caddy's admin API is disabled. Gate configuration is baked into the deploy artifact rather than
pushed to a live config surface
([`../archive/08-distribute-gate-config-to-proxy.md`](../archive/08-distribute-gate-config-to-proxy.md)),
so with no push there is no reason to expose a mutation surface in front of every app.

### 3. Gates are evaluated once, in TypeScript, in the auth service

A gate rule is never compiled into a route matcher, a firewall rule, or any other engine's
configuration. The auth service receives the app's rule list verbatim in its manifest, order
preserved, and evaluates it with the canonical matcher in `@fabrika/auth-core`.

Semantics are the declared ones, verbatim: array order is precedence; a matching rule whose
credential is **absent** falls through to the next matching rule; a matching rule whose credential
is **present** is terminal; a request matching **no** rule is denied.

- `public` — terminal allow, no credential read and no IAM call. No token is minted, so the app
  sees an anonymous request.
- `service` — a `px_` credential or a passthrough JWT, as a bearer or at the rule's declared
  location. Absent falls through; present and invalid denies.
- `human` — a resolved **user** principal. A valid token is not enough: `issueJwt` signs an
  anonymous token and `mintFromKey` signs `ptype: 'service'`, so every tier checks the claim.

ADR-0010 records the three properties of Caddy's matcher that make the alternative unsafe —
case-insensitive path matching, `*` not crossing `/`, and fall-through being inexpressible as a
matcher at all. Read it before revisiting this; the point is that any second evaluator gates a
_slightly different set of requests_ than the app declared, silently, in the permissive direction.

**Invariant: every unexpected condition denies.** Nothing in the authorization core returns an
allow on a path it did not plan for.

**Invariant: a decided negative and an unreachable IAM are different denials.** "This token is bad"
is a 401/403; "we could not check" is a 503. Both refuse, only the second is an incident, and a 503
on the human path must never degrade into a bounce to login — that is a login loop hiding an
outage.

### 4. A session reaches an app through a one-time code the proxy redeems

On a `human` gate miss the proxy answers with the login URL,
`${issuer}/auth/login?app=<id>&redirect=<original URL>`, in the shape the caller can act on: a
**302** for a document navigation, a **401** carrying `{ error: { type, message, loginUrl } }`
otherwise. The signal is `Sec-Fetch-Mode` — `Sec-` is a forbidden header prefix, so the browser
writes it and page JavaScript cannot, which makes it describe the caller instead of letting the
caller choose the answer. An absent value reads as a navigation, because a non-browser client is
what has no opinion.

IAM authenticates the human, then issues a single-use code bound to `(session, app, return URL)`
and redirects to the app's own host at the reserved path `/__fabrika/auth/callback`. The proxy
answers that path itself, before gate matching — it is how a browser becomes able to satisfy a
gate, so it cannot be behind one — redeems the code with IAM, sets the returned **app session** as
a host-only cookie, and redirects to the return URL IAM stored with the code.

Redemption yields a **session**, not a bare access token, and that is deliberate. An access token
lives five minutes; a browser holding only one would be redirected on every expiry, and a redirect
turns an in-flight `POST` into a bodyless `GET`. What lands on the app's host is a credential the
proxy can re-mint from, server-side, exactly as it does from an IAM-host session when the domains
happen to match.

The invariants ADR-0021 established are carried forward, with one narrowed by implementation:

**Invariant: a child session mints only for the app it is bound to.** The cookie is host-only, so a
sibling cannot read it; the binding checked at every mint is the second lock. A child session
cannot father another — only an IAM login authorizes a handoff.

**Invariant: the code is single-use, short-lived (two minutes) and stored only as a hash.** The
plaintext exists in one redirect and one redemption. Consumption is a conditional `UPDATE`, so a
replay changes no rows and loses. The proxy's access-log redaction carries `?code=`
unconditionally, because it is not a declared credential and nothing else would contribute it.

**Invariant: IAM never issues a code for a return URL it has not been told to trust.** The registry
is per app. An app _with_ a registry that does not contain the address is a 400, never a quiet
fallback. An app with an **empty** registry has not opted in and takes the shared-cookie path
instead (see Consequences) — except where the shared cookie provably cannot reach the destination,
which is also a 400 rather than a login loop nobody can diagnose. ADR-0021 stated this as a flat "an
unregistered origin is a 400"; the narrowed form is what an installation that never adopted the
handoff needs in order to keep working.

**Invariant: revoking an IAM login revokes every app session derived from it.** A child carries its
parent's id and the lookup joins to the parent on every use. The bound is unchanged and unchanged
by design: an already-minted access token is verified locally and stays valid for the rest of its
TTL.

**Invariant: the proxy writes a cookie on exactly one path** — a successful redemption at the
reserved callback, and nowhere else. It is otherwise a pure enforcement point, and every extra
write site is another place a mistake establishes a session.

### 5. An app verifies an injected token; it never enforces

The proxy hands the app a verified access token on `X-Fabrika-Token`. The application SDK
(`@fabrika/auth`) reads that header, verifies it **locally** against IAM's published JWKS —
signature, `iss`, `aud`, `exp` — and builds the `AuthContext`. That is the whole of its request-time
authentication surface. It evaluates no gate, exchanges no session, writes no cookie, and issues no
login bounce.

Verifying a token the proxy already admitted is not redundancy for its own sake: it is what keeps
the app honest about which issuer and which audience it accepts, so a token minted for another app
is refused at the app too.

What an app _does_ own is the check a path gate cannot make: `can(action, scope)` over an
application-owned object coordinate, resolved from validated request data. A gate never replaces
that check, and that check never replaces a gate.

**Invariant: an application has no local authentication variant.** The SDK has no dev flag, no fake
client and no synthetic persona; `createIam` requires the binding and the issuer everywhere,
including locally. Every dev bypass belongs to **IAM**, the service that owns identity, and is
gated on `ENVIRONMENT=local`: the login bypass additionally requires `LOCAL_DEV_LOGIN=true`, mints a
real session row for a fixed bootstrap admin, and is refused at use the moment the flag is off; the
credential-less caller bypass additionally requires that no durable signing keys are configured,
which a real deploy always provides. Adding one back to an application is the bug — that is where a
total silent bypass hid before.

The one credential path an app still redeems itself is a share link, and it is deliberately **off**
the gate path: such a request passes a `public` or `service` gate and the app redeems the
capability afterwards. There is no proxy equivalent, by design.

## Consequences

### The Cloudflare least-privilege split is a typing convention, not a boundary

ADR-0021 put handoff redemption on the proxy's own mint surface rather than on `IamRpc`, on
ADR-0007's least-privilege grounds. **On Zerops that split is real.** IAM serves two HTTP surfaces
with two different keys: `/rpc/*`, the management surface, gated by `FABRIKA_IAM_RPC_KEY`, and
`/auth/mint/*`, the proxy surface, gated by `FABRIKA_IAM_PROXY_KEY`. A holder of the RPC key
genuinely cannot redeem a code, and an unset key makes its surface 404 as if never mounted.

**On Cloudflare there is no split.** IAM is one `WorkerEntrypoint` implementing both `IamRpc` and
`IamHandoffRpc`, so `exchangeAuthCode` is an ordinary method on it and every holder of the `IAM`
service binding can call it. No key is involved on that path at all. The separation survives only
as a type: an SDK consumer declares its binding as `IamRpc` and therefore never sees the method.

We accept this rather than splitting the entrypoint. To profit from it an attacker needs a Worker
holding the `IAM` binding — already a first-party, already-trusted component — **and** a live,
unconsumed code inside its two-minute window. What actually stops replay is the code's own
properties: single-use via a conditional `UPDATE`, hash-only storage, and the
`(session, app, return URL)` binding. So this is a defence-in-depth degradation on one provider,
not an exploitable hole, and a second entrypoint buys little for real churn.

The genuine defect was documentary — the reference read as though the split held on both providers.
It is recorded here so nobody re-derives it, and
[`../reference/cross-host-sso.md`](../reference/cross-host-sso.md) now says which provider it
holds on.

### There are two session-delivery mechanisms, and whether to keep both is open

ADR-0021 kept the shared cookie alongside the handoff on the grounds that it "costs nothing, keeps
the local stack working unchanged, and remains the right path when the app genuinely does share a
domain with IAM". Two of those three still hold. "Costs nothing" does not:

- **It blocks the `__Host-` cookie prefix.** `__Host-` forbids the `Domain` attribute, and
  `SESSION_COOKIE_DOMAIN` exists to set one. The prefix cannot be applied to the session cookie in
  any installation on the shared-cookie path — including the local stack, which is deliberately on
  it.
- **It is a second path through the login route**, and it is why the return-origin check needed the
  narrowed opt-out in rule 4 rather than a flat refusal.

The argument for retiring it has also strengthened: registering an app's return origins is now one
ordinary admin call made on every deploy, so the local stack could run the handoff too. The
argument against is that it is genuinely cheaper — it saves a redirect — when an app really does
share a domain with IAM, and retiring it would contradict an explicitly reasoned choice.

**This ADR does not decide it.** Both mechanisms exist, the handoff is the one that works
everywhere, and the shared cookie is an optimisation for co-located hosts. Retiring it is a
separate decision with its own consequences (`__Host-` on both cookies, `SESSION_COOKIE_DOMAIN`
deleted, local development moved onto the handoff), and it must be taken deliberately rather than
absorbed into a consolidation.

### The rest

- **One implementation of the security-critical path, on both providers.** A fix lands once. This
  is ADR-0008's central claim, and deleting the SDK's copy is what finally made it true.
- **The proxy is a per-deployment single point of failure**, and it is now also the only thing that
  can establish an app session. Both are arguments for keeping it thin. If the auth service dies,
  Caddy answers 502 and every request is denied — by design, not a gap.
- **A second language and toolchain stay in an otherwise all-TypeScript repo**: a generated Caddy
  config, a pinned Caddy binary, an Alpine runtime. Real cost, accepted (ADR-0008).
- **One local `forward_auth` hop per request** on Zerops, inside the project's private network, on
  the warm path.
- **A reserved path exists on every app host.** `/__fabrika/auth/callback` is shadowed by the proxy
  and never reaches the upstream, so an application route at that path silently stops working.
- **The proxy needs its public scheme as configuration.** No header can supply it: a TLS-terminating
  balancer forwards plain HTTP and the next hop rewrites `X-Forwarded-Proto` to what it received. It
  comes from the manifest, and an absent value parses as `https`.
- **The return-origin registry is new operational surface.** An app whose public origin changes and
  whose registration does not stops being able to log anyone in. It is fail-closed, which is the
  right direction.
- **Refusing to boot beats booting misconfigured.** The Bun proxy requires `FABRIKA_IAM_URL` and
  `FABRIKA_IAM_KEY` and dies without either, because IAM's mint surface 404s without the key and a
  proxy that booted anyway would 503 everything.

## Alternatives considered

Every alternative this model rejected is argued in the four superseded ADRs, and the arguments are
not repeated here:

- in-process SDK enforcement, Cloudflare Access, per-project IAM instances, and a sidecar per app —
  [ADR-0007](0007-proxy-based-auth-enforcement.md);
- a Go plugin inside Caddy, Traefik, a TypeScript proxy on both platforms, and nginx
  `auth_request` — [ADR-0008](0008-caddy-forward-auth-proxy.md);
- normalising the gate glob to Caddy's semantics, and dropping fall-through so gates could be
  routes — [ADR-0010](0010-gate-evaluation-stays-in-the-auth-service.md);
- requiring a custom domain per installation, putting every app on one hostname, and minting from
  the session over a back channel — [ADR-0021](0021-exchange-token-session-handoff.md).

One alternative belongs to this ADR rather than to any of them: **writing four amendments instead of
one consolidation.** Rejected because the problem being fixed _is_ the chain. A fifth correction
appended to four would leave the same reader replaying the same documents, one document longer.
