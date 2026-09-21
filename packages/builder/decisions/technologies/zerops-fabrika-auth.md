---
id: zerops-fabrika-auth
kind: technology
title: Fabrika IAM with proxy-only enforcement on Zerops
slot: authz
provides: [authentication, authorization, proxy-enforcement]
requires: [zerops-platform]
recommends: []
conflicts: [propustka, cloudflare-access, auth-password-kv]
npm: ["@fabrika/auth@^0.0.4", "@fabrika/auth-core@^0.0.4"]
status: wip
sources:
  - where: "packages/auth/CLAUDE.md + src/index.ts + src/iam.ts in fabrika-platform"
    read: "Verify-only SDK, real IAM requirements, negative versus unavailable results."
  - where: "examples/zerops-app/fabrika.gates.ts + fabrika.schema.ts + src/authz.ts in fabrika-platform"
    read: "Proxy gate declarations, app vocabulary and the example's direct JWKS verification."
  - where: "docs/decisions/0022-the-proxy-is-the-only-enforcement-point.md + 0023-one-session-per-host.md in fabrika-platform"
    read: "Single gate evaluator, per-host session handoff and application-owned object authorization."
---

# Fabrika IAM with proxy-only enforcement

Declare the application's `AppSchema` vocabulary and ordered `AppGates` in source.
Attach the gates to `target.proxy` in `fabrika.config.ts`. Control reconciles the
schema and registers deployment return origins; the application does not assert
its own trusted return origins through its schema.

The proxy alone evaluates gates, handles login and the reserved
`/__fabrika/auth/callback` route, and injects `X-Fabrika-Token`. App services remain
private. Never implement another gate evaluator in the app, frontend or Caddy
route configuration.

The application verifies the injected token's signature, issuer, audience and
expiry against IAM's JWKS. Prefer the `@fabrika/auth` SDK's `createIam` and
`authenticate` contract where its IAM binding is available; read the installed
types when composing the HTTP transport. The public notes example demonstrates
direct JWKS verification with `@fabrika/auth-core` claim parsing. Neither path
trusts an unverified header or gives the app a session-to-token exchange.

Keep per-object authorization in feature handlers using the verified context and
validated object scope (`can`, `requirePermission`, or the example's `Caller`).
Public-gated routes use an anonymous context with no permissions. Preserve SDK
failure semantics: a decided invalid credential differs from IAM unavailability,
which refuses with 503 rather than pretending the credential was checked.

## Local authentication is the same model

Run real IAM and the proxy locally. IAM's own `LOCAL_DEV_LOGIN` mechanism can
create a real local session; it is not an application dev flag. Restricted-role
tests need real IAM principals and grants, not the bootstrap admin for every
scenario. Never synthesize a caller, mint tokens in the app, add `FakeIamClient`,
or disable gates to make local previews work. Credentials and raw request headers
must not enter logs or committed fixtures.
