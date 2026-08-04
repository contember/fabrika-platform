---
id: 50
title: Fix the CSRF origin check behind a terminating balancer
blocked-by: []
---

# 50 — Fix the CSRF origin check behind a terminating balancer

**Summary.** Every state-changing request to the Access admin surface answers
`403 cross-origin request rejected` when the deployment sits behind a
TLS-terminating balancer — from a real browser, with a valid session. The console
cannot invite a user, create a grant, issue a key, or run any of the new password
actions. Verified live on 2026-08-04 in `fabrika-test`, on both the direct IAM
origin and the console path through the control plane.

## Problem

Two independent guards compare the browser's `Origin` header against an origin
they reconstruct from the request URL:

- `rejectCrossOrigin` (`packages/iam/src/admin/router.ts:99`) — `origin === url.origin`,
  where `url` is `new URL(request.url)`;
- `sameOriginMutation` (`packages/control/src/iam-admin.ts:61`) — the same comparison
  on the control plane's own request.

The Zerops L7 balancer terminates TLS and forwards plain HTTP, so the process
reconstructs `http://host` while the browser sent `https://host`. The scheme
differs, the strings differ, and the request is rejected before any credential is
read. Live:

```
POST /iam/admin/rpc   Origin: https://proxy-292c-8082…  → 403 cross-origin request rejected
POST /iam/admin/rpc   Origin: http://proxy-292c-8082…   → 401 missing_token   (guard passed)
```

The second line is the proof: only the scheme distinguishes a rejected request
from one that reaches the real authorization check.

This is the same root cause as [`48`](./48-decide-how-the-proxy-learns-its-public-scheme.md)
— "what scheme did the BROWSER actually speak?" — but it is not the same item.
48 is a wrong redirect target and needs a decision because the proxy has no
configured public origin to fall back on. This one is a hard functional block on
an already-shipped write surface, and both services **do** hold a configured public
origin already.

It does not reproduce on Cloudflare, where `request.url` carries the browser's
scheme. It is specific to a process behind a terminating balancer, which is every
Zerops deployment.

## The second consequence: no machine caller can write

The same guard rejects a state-changing request that carries **neither** `Origin`
nor `Referer` — which is every plain HTTP client. A CLI holding
`FABRIKA_IAM_PROVISIONING_KEY` can read the admin surface and cannot write to it:

```
GET  /admin/principals   bearer, no Origin → 200
POST /admin/principals   bearer, no Origin → 403 cross-origin request rejected
POST /admin/rpc          bearer, no Origin → 403 cross-origin request rejected
```

This one is not scheme-dependent and reproduces on Cloudflare too. It contradicts
two places that describe the bearer as a machine path: the credential comments at
`packages/iam/src/admin/router.ts:51` and `:140` ("machine credential",
"CI / provisioning"), and the documented first-administrator procedure for an
email-less installation — "the existing `FABRIKA_IAM_PROVISIONING_KEY` bearer calls
the IAM admin RPC to invite the first user and issue a manual enrollment link"
([`../reference/human-authentication.md`](../reference/human-authentication.md)).
That procedure cannot be executed as written; the live run on 2026-08-04 completed
it only by sending a fabricated `Origin` header.

CSRF is an ambient-authority attack: it exists because a browser attaches the
cookie by itself. A bearer token is never attached automatically, so the guard buys
nothing against a bearer-only request while blocking the only documented bootstrap.
Exempt requests authenticated **solely** by `Authorization`, and keep the check for
anything carrying `px_session`.

Two things found alongside it, both load-bearing for the fix:

- The comment at `packages/iam/src/admin/router.ts:93-97` states that the
  control-plane gateway rewrites `Origin` and `Referer` to the private
  destination. **It does not.** `forwardIamAdmin` (`packages/control/src/iam-admin.ts:24`)
  builds `new Request(target, request)`, which copies the browser's headers
  verbatim. IAM's guard therefore sees the browser's `Origin` against a
  gateway-derived URL, and the comment describes a protection that is not there.
- `FABRIKA_CONTROL_DOMAIN` has no settled shape. The local stack sets an origin
  (`http://control.fabrika.localhost:18080`, `packages/local-stack/compose.yaml:117`);
  the live installation holds a bare host (`proxy-292c-8082.prg1.zerops.app`).
  Nothing noticed, because its only consumer treats it as a boolean —
  `secureCookies` (`packages/control/src/iam.ts:76`) reads it for truthiness alone.

## Approach

Compare against the CONFIGURED public origin, not the reconstructed request URL.
The pattern is already in the repo twice and needs no new configuration:
`sameOrigin` (`packages/iam/src/auth/routes.ts:584`) checks the password forms
against `config.issuer`, and control derives the `px_token` cookie's `Secure` flag
from `FABRIKA_CONTROL_DOMAIN` rather than the socket. IAM has `config.issuer`;
control has `FABRIKA_CONTROL_DOMAIN` — but settle that variable's shape first, or
the comparison silently fails on one of the two deployments that set it
differently.

Keep the guard fail-closed: a state-changing request with neither `Origin` nor
`Referer` must still be rejected, and an unconfigured public origin must not
degrade to "accept anything".

## Acceptance

A unit test per guard asserting that a browser `https://` origin is accepted when
the process reconstructs `http://` for the same host, and that a genuinely
cross-site origin is still rejected. Then, live: sign in to the console on the
Zerops installation and complete one write — inviting a user is enough — with no
fabricated request header anywhere. Correct the stale comment in the same change.

<!-- Origin: live password-auth verification on fabrika-test, 2026-08-04. -->
