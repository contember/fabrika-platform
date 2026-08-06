# @fabrika/proxy-core

The auth enforcement **decision**, as a runtime-neutral library: take a forwarded request, decide,
and mint or refuse. Nothing reaches an app until its gates pass
([ADR-0022](../../docs/decisions/0022-the-proxy-is-the-only-enforcement-point.md), which supersedes
0007/0008/0010/0021). Assumes the root CLAUDE.md.

There are two enforcement points and they run the same code from here: the Bun service answering
Caddy's `forward_auth` subrequest on Zerops (`@fabrika/proxy`), and the Cloudflare proxy Worker
calling it in-process (`@fabrika/provider-cloudflare`). The manifest wire contract and its strict
parser are `@fabrika/proxy-contract`; the gate matcher and the token claims are `@fabrika/auth-core`.

**The behavioural invariants live in [`../proxy/CLAUDE.md`](../proxy/CLAUDE.md)** — deny semantics,
the three-state `verify`, the `human` gate's answer shape, the client-coordinate table, and the
session handoff. They are properties of the decision, so they apply here; that file is not repeated.

## Commands (this package)

```bash
bun test   # deny-matrix.test.ts is the authorization truth table — keep it exhaustive
```

## Invariants

- **Runtime-neutral by construction.** No Caddy, no filesystem, no process, no `Bun.*`. If something
  here needs to know how it is deployed, it belongs in `@fabrika/proxy` or in the provider bundle.
  This is what lets one decision serve a Worker and a Bun process without a second implementation.
- **This package is PUBLIC; `@fabrika/proxy` is not.** The split exists because
  `@fabrika/provider-cloudflare` is published and needs the decision — it must never need the Caddy
  deployment. Anything added here becomes public API; the release gate (`bun run release:validate`)
  enforces the direction and the public inventory in `scripts/release.ts` is deliberate.
- **Every `catch` maps to a deny.** Nothing in `src/authorize.ts` returns an allow on an unexpected
  condition. A request matching no gate rule is denied.
- **The request being authorized is described ENTIRELY by the forwarded headers.** Never read the
  incoming request's own method or path; a missing `X-Forwarded-Uri` must deny, not fall back.
- **The token cache is best-effort and per-process.** Every entry is re-verified against the JWKS
  before it is trusted, and `null` (no cache) is a supported configuration that changes only how many
  times IAM is called — never which requests are allowed. ADR-0022 requires the proxy to stay
  stateless, so never make it shared or persistent.
- **There is exactly one gate evaluator, in `@fabrika/auth-core`.** This package composes it; it does
  not reimplement or extend gate semantics.
- **Test helpers are imported across packages.** `src/__tests__/helpers.ts` fakes IAM at the
  `IamGateway` seam and signs real ES256 tokens; `provider-cloudflare` and `local-stack` import it by
  relative path so the two enforcement points are tested against the same doubles. It is excluded
  from the published `files`. Moving or renaming it breaks those suites — grep before you do.
