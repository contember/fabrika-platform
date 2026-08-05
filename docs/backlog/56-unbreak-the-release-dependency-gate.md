---
id: 56
title: Unbreak the release dependency gate
blocked-by: []
---

# 56 — Unbreak the release dependency gate

**Summary.** `bun run release:validate` has been failing since `18d9575`. It is the gate the
release pipeline runs, so nothing can be published until it is decided — and because the
failure is a real dependency-direction violation rather than a broken script, "fixing" it means
choosing what `@fabrika/proxy` is.

## Problem

```
@fabrika/provider-cloudflare: public dependencies must not depend on private package @fabrika/proxy
```

`release:validate` enforces that every package is either `private: true` or declares
`publishConfig.access: "public"`, and that no public package depends on a private one.
`@fabrika/provider-cloudflare` is published; `@fabrika/proxy` is not. `18d9575`
("feat(proxy): enforce Cloudflare app routes through proxy") made the provider import the proxy —
correctly, that is what routes a Cloudflare app through its proxy Worker — and the gate has been
red ever since.

Confirmed pre-existing: reproduced against a pristine checkout of `c8c8c35`.

## Approach

Two coherent answers and the choice is not obvious:

- **Publish `@fabrika/proxy`.** It becomes public API, with everything that implies for its
  surface — `buildCaddyConfig`, the verifier, the gate compiler. The provider genuinely needs it.
- **Move what the provider needs into a package that is already public.** The provider imports
  constants (`PROXY_TOKEN_HEADER`, `CLIENT_ADDRESS_HEADER`, the forwarded-header names) and the
  verify service. The constants already live in `@fabrika/auth-core`, which is public and
  provider-free; the verify service does not.

Whichever is chosen, the gate must go green rather than be relaxed — its whole job is to stop a
published package resolving to something nobody can install.

## Acceptance

`bun run release:validate` exits 0, and the dependency-direction rule is unchanged.

<!-- Origin: sprint auth-track-closeout, 2026-08-05, WU-E found it while verifying its own acceptance. -->
