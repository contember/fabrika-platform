---
id: auth-password-kv
kind: pattern
title: Password + session-in-KV auth (app-owned)
slot: authentication
provides: [authentication, sessions, invites]
requires: [kv]
recommends: [d1]
conflicts: [cloudflare-access]
npm: []
status: stable
sources:
  - where: "Pattern. Reference: the cf-fat stack (app/auth.ts) + WebCrypto PBKDF2/scrypt."
    read: "Password hashing with WebCrypto, session token in a cookie backed by KV, invite tokens, route guards."
---

# Password + session-in-KV auth

## What it is

App-owned authentication: **password hashing** (WebCrypto PBKDF2/scrypt) + a
**session token in a cookie backed by KV** + admin bootstrap + invite tokens + route
guards. The simplest correct self-hosted login when you're not behind Cloudflare
Access.

## When & why to use

- Self-hosted single-team tool with admin bootstrap + invites, no IdP/SSO needed in M1.
- You can't put users behind Access (e.g. external invitees) but don't need full OAuth.

## When NOT to use

- You have an IdP / want managed SSO → `cloudflare-access`.
- Consumer product needing OAuth / magic-link at scale → a dedicated auth provider.

## Impacts & gotchas

- **Never store plaintext** — hash with WebCrypto (PBKDF2/scrypt); compare in constant time.
- Session token in an HttpOnly cookie, validated against `kv` (with TTL); guard protected routes server-side.
- User records / membership in `d1`; session/invite ephemera in `kv`.

## Relationships — why

- **requires `kv`** — session + invite tokens live there. **recommends `d1`** — user/membership records.
- **conflicts `cloudflare-access`** — both fill the `authentication` slot; app-owned password vs managed SSO. Pick one.
