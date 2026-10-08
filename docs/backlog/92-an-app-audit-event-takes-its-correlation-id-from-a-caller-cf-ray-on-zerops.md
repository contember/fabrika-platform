---
id: 92
title: An app's audit event takes its correlation id from a caller's cf-ray on Zerops
blocked-by: []
---

# 92 — An app's audit event takes its correlation id from a caller's cf-ray on Zerops

**Summary.** `@fabrika/auth` reads the audit correlation id from `cf-ray` on every composition. On
Zerops no edge writes that header and the proxy does not strip it, so a caller chooses the
`request_id` of an application's audit event. IAM itself no longer trusts a caller here; the
app-facing SDK still does. Effort S.

## Problem

- `packages/auth/src/request.ts` `readRequestId` returns `cf-ray`, else a fresh UUID.
  `IamAuth.authenticate` (`packages/auth/src/iam.ts:141`) puts it into the `AuthContext`, whose
  `audit()` forwards it to `IamRpc.audit`; `readCredentials` forwards it to `listPrincipals`.
- On Cloudflare the edge writes `cf-ray`, so the value is outside the caller's reach. On Zerops the
  Caddy route deletes `X-Fabrika-Token`, `X-Request-Id`, `X-Fabrika-Client-Ip` and
  `UNTRUSTED_FORWARD_HEADERS` (`packages/proxy/src/caddy.ts:343`, `packages/auth-core/src/wire.ts:30`:
  `X-Forwarded-For`, `CF-Connecting-IP`). A caller's `cf-ray` reaches the app. The proxy's own
  `X-Request-Id`, which it does inject, is ignored by the SDK.
- Control and Operations take their audit correlation id from this SDK too (`createIam` in
  `packages/control/src/iam.ts`, `packages/control/src/zerops/mcp.ts` and
  `packages/operations/src/auth.ts`); neither reads a correlation header of its own.
- `IamRpc` replaces a malformed `requestId` (`packages/iam/src/rpc.ts`, `acceptRequestId`), so the
  stored value is bounded. A well-formed forged id is still accepted.

## Approach / acceptance

The SDK takes the trusted correlation header from its composition, as IAM's composition roots do
(`packages/iam/src/request-id.ts`): `cf-ray` on Cloudflare, the proxy-written `X-Request-Id` on
Zerops. Alternatively the proxy strips `cf-ray` on Zerops and the SDK falls back to `X-Request-Id`.

Acceptance: on the Zerops composition a caller-supplied `cf-ray` does not become the `request_id` of
an app's audit event.

## Touch points

`packages/auth/src/request.ts`, `packages/auth/src/iam.ts`, the app runtime adapters in
`packages/app/`; possibly `packages/auth-core/src/wire.ts` and `packages/proxy/src/caddy.ts`.

<!-- Origin: sprint-2026-10-08-local-hardening-port, P2 review of other services (first found 2026-09-28). -->
