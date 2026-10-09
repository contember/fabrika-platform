---
id: cloudflare-access
kind: technology
title: Cloudflare Access (legacy/alternate edge authentication)
slot: authentication
provides: [authentication, sso]
requires: [cloudflare]
recommends: []
conflicts: [auth-password-kv, propustka]
npm: ["jose@^5"]
status: stable
sources:
  - where: "developers.cloudflare.com/cloudflare-one/policies/access (Access JWT, application audience, identity)"
    read: "How Access fronts a Worker, the JWT it injects, and how to validate it (aud/iss, JWKS)."
  - where: "A legacy app that still uses Access JWT validation"
    read: "A live example of validating the Access JWT and resolving identity downstream; do not copy it into native Propustka apps."
---

# Cloudflare Access (authentication)

## What it is

Cloudflare's zero-trust **authentication** layer sitting in front of a Worker. It
handles "who you are" (SSO / IdP / one-time PIN), injects a signed JWT, and the
Worker validates it (via `jose` — `aud`, `iss`, JWKS). It owns _authentication
only_. This is now the legacy/alternate front door for apps that have **not**
adopted native Propustka sessions.

## When & why to use

- Self-hosted / internal tools where you want SSO without building login yourself.
- You intentionally keep an older Access-fronted app and are not migrating it to
  native Propustka sessions yet.

## When NOT to use

- Public sign-up product (consumers can't be behind Access) → use `auth-password-kv` or an IdP-direct flow.
- You need app-owned credential lifecycle (password reset, invites) as a product feature.

## Impacts

- Production traffic must pass through Access; **local dev needs a dev-only
  identity shim**.
- The Worker trusts the Access JWT — validate `aud`/`iss` against your application audience + team JWKS, never skip it.

## Relationships — why

- **conflicts `propustka`** — current Propustka owns native SSO sessions and
  request authorization; it no longer expects a Cloudflare Access edge.
- **conflicts `auth-password-kv`** — both fill the `authentication` slot. Access = managed SSO; auth-password-kv = app-owned password+session. Pick one.
