# @fabrika/proxy-core

The auth enforcement **decision**, as a runtime-neutral library: take a forwarded request, decide,
and mint or refuse. Nothing reaches an app until its gates pass
([ADR-0022](../../docs/decisions/0022-the-proxy-is-the-only-enforcement-point.md), which supersedes
0007/0008/0010/0021). Assumes the root CLAUDE.md.

There are two enforcement points and they run the same code from here: the Bun service answering
Caddy's `forward_auth` subrequest on Zerops (`@fabrika/proxy`), and the Cloudflare proxy Worker
calling it in-process (`@fabrika/provider-cloudflare`). The manifest wire contract and its strict
parser are `src/manifest.ts`, exported as `@fabrika/proxy-core/manifest`; the gate matcher and the token claims are `@fabrika/auth-core`;
the JWKS token verifier is `@fabrika/jwks`, the same class `@fabrika/auth` wraps.

**The behavioural invariants live in [`../proxy/CLAUDE.md`](../proxy/CLAUDE.md)** — deny semantics,
the three-state `verify`, the `human` gate's answer shape, the client-coordinate table, and the
session handoff. They are properties of the decision, so they apply here; that file is not repeated.

## Commands (this package)

```bash
bun test   # deny-matrix.test.ts (gates) and endpoint-matrix.test.ts (endpoint tables) are the truth tables — keep them exhaustive
```

## Invariants

- **Runtime-neutral by construction.** No Caddy, no filesystem, no process, no `Bun.*`. If something
  here needs to know how it is deployed, it belongs in `@fabrika/proxy` or in the provider bundle.
  This is what lets one decision serve a Worker and a Bun process without a second implementation.
- **This package is PUBLIC; `@fabrika/proxy` is not.** The split exists because
  `@fabrika/provider-cloudflare` is published and needs the decision — it must never need the Caddy
  deployment. Anything added here becomes public API; the release gate (`bun run release:validate`)
  enforces the direction and the public inventory in `scripts/release.ts` is deliberate.
- **`@fabrika/proxy-core/manifest` imports only zod and `@fabrika/auth-core` types.** Producers
  (providers, control, local-stack) import it without the decision, so never import `jose`, the
  verifier, or anything else from `src/` into `src/manifest.ts`. Malformed input never becomes a
  partially accepted manifest.
- **A host is a NAME, never a pattern.** `isProxyHost` accepts a literal lower-cased LDH hostname
  (labels 1–63 chars, ≤ 253 total), and `proxyAppSchema` rejects the whole manifest when a host fails
  it. The manifest is the authority on hosts (ADR-0022), and Caddy's `host` matcher reads `*` as a
  wildcard label: on Zerops one proxy fronts every app in a namespace, so an accepted pattern captures
  the sibling apps' hostnames. Never relax it to accommodate a producer; fix the producer.
- **Every `catch` maps to a deny.** Nothing in `src/authorize.ts` returns an allow on an unexpected
  condition. A request matching no gate rule is denied.
- **The request being authorized is described ENTIRELY by the forwarded headers.** Never read the
  incoming request's own method or path; a missing `X-Forwarded-Uri` or `X-Forwarded-Method` must
  deny, not fall back.
- **The forwarded path is checked RAW, before any URL is built.** `isCanonicalPath` from
  `@fabrika/auth-core` runs on the header's path; a non-canonical one is a 400 (`non_canonical_path`)
  before any gate is matched. Assigning a pathname resolves `..` and `%2e%2e`, so checking after it
  would match `/admin` while the upstream receives `/a/../admin`.
- **The token cache is best-effort and per-process.** Every entry is re-verified against the JWKS
  before it is trusted, and `null` (no cache) is a supported configuration that changes only how many
  times IAM is called — never which requests are allowed. ADR-0022 requires the proxy to stay
  stateless, so never make it shared or persistent.
- **There is exactly one gate evaluator, in `@fabrika/auth-core`.** This package composes it; it
  does not reimplement or extend gate semantics. A gate path is a glob: `*` crosses `/`, and a whole
  `:name` segment matches exactly one non-empty segment, the rule endpoint tables use. Array order
  is precedence for installation gates only.
- **A manifest app is a gate app or a contract app, never both.** `endpoints` (with
  `reservedPrefixes` and `snapshot`) instead of `gates` makes a contract app; an app carrying both, or
  OAuth resources beside a table, is refused whole. A contract app's request is one pass over the row
  `planEndpoint` selects (ADR-0022 rule 3): no row → 403; a presented `Authorization` header is a
  `px_` key and terminal, and its caller kind (`callerOf`, re-checked on cached tokens) must be one
  of the row's callers → 403; no key and no `human` caller → 401, never a bounce; the session or the
  login bounce; `satisfies` → 403; admission (a session non-`GET` needs `Sec-Fetch-Site:
  same-origin` → 403, the media type must be one the row admits → 400). An anonymous kind reads no
  credential and mints no token. The allow carries `X-Fabrika-Endpoint: <id>@<digest>`.
- **A row's digest is checked where the manifest is parsed.** The parser recomputes
  `requirementDigest` and refuses a row whose digest differs, so the digest the proxy sends always
  describes the rules it applied. Producers build rows with `contractProxyTable(artifact)`, never by
  hand.
- **A delegation grant is fresh per request.** A row marked `members` or `creates` gets a single-use
  grant from `delegations` (a structural subset of IAM's membership RPC) after every other check
  passed, also on a warm token cache, and it rides in `X-Fabrika-Delegation`. A refused grant is a
  403, an unreachable IAM a 503. Both compositions pass one: the Bun service its `HttpIamGateway`
  (`POST /auth/mint/delegation` on IAM's proxy surface), the Cloudflare Worker its `IAM` binding. The
  row's `delegation` is part of its digest, so a manifest cannot add or drop a grant unnoticed.
- **Test helpers are imported across packages.** `src/__tests__/helpers.ts` fakes IAM at the
  `IamGateway` seam and signs real ES256 tokens; `provider-cloudflare` and `local-stack` import it by
  relative path so the two enforcement points are tested against the same doubles. It is excluded
  from the published `files`. Moving or renaming it breaks those suites — grep before you do.
