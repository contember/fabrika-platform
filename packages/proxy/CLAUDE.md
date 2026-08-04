# @fabrika/proxy

The auth **enforcement point**: a Bun service answering Caddy's `forward_auth` subrequest. Nothing
reaches an app until its gates pass (ADR-0007, ADR-0008, ADR-0010). Assumes the root CLAUDE.md. The
manifest wire contract and its strict parser live in `@fabrika/proxy-contract`; the gate matcher and
its compiled form live in `@fabrika/auth-core`.

## Commands (this package)

```bash
bun run dev           # run src/main.ts directly
bun run build         # generate caddy.json + compile the fabrika-proxy binary (musl, static)
bun run build:check   # the same against fixtures/empty.manifest.json
bun test              # deny-matrix.test.ts is the authorization truth table — keep it exhaustive
```

## Invariants

- **Every `catch` maps to a deny.** Nothing in `src/authorize.ts` returns an allow on an unexpected
  condition. A request matching no gate rule is denied.
- **The service binds to LOOPBACK.** It answers "is this request allowed" and hands back a signed
  token, so a publicly routable instance is a token oracle. Caddy is the only thing that may dial it.
- **The request being authorized is described ENTIRELY by the forwarded headers.** Never read this
  request's own method or path; a missing `X-Forwarded-Uri` must deny, not fall back.
- **The generated Caddy config strips the token header from the inbound request before
  `forward_auth` runs.** Caddy's `copy_headers` skips empty values rather than deleting, so without
  the strip a client could present its own token header on a `public` path and have it reach the app.
- **Gate rules are NOT compiled into Caddy routes** — every request goes to `/verify` and gates are
  evaluated once, in TypeScript. Caddy's `path` matcher is case-insensitive, its `*` stops at `/`,
  and it normalizes the path; the SDK's glob does none of those, and fall-through is not expressible
  as a matcher at all. Any of those mismatches silently widens or narrows an authorization rule. Read
  the header of `src/caddy.ts` before revisiting this.
- **Gate semantics are `AppGates`', verbatim:** array order IS precedence; a matching rule whose
  credential is ABSENT falls through; a matching rule whose credential is PRESENT is terminal.
- **The token cache is best-effort and per-process.** Every entry is re-verified against the JWKS
  before it is trusted, and `null` (no cache) is a supported configuration that changes only how many
  times IAM is called — never which requests are allowed. ADR-0008 requires the proxy to stay
  stateless, so never make it shared or persistent.
- **`verify` is three-state.** "This token is bad" (401/403) and "we could not check" (503) are
  different denials. Both deny; only the second is an incident.
- **Refusing to boot beats booting misconfigured** (`src/env.ts`). `FABRIKA_IAM_KEY` is the only
  secret here — read once, never logged, never echoed, never put in a URL.
- **If the auth service dies, Caddy answers 502 and every request is denied.** `start.sh` restarts it
  in a loop; that failure mode is by design, not a gap to paper over.

## Patterns

- `src/generate-config.ts` runs at BUILD time: `proxy.manifest.json` → `caddy.json`, baked into the
  artifact, so a gate change ships with the app's next deploy rather than being pushed to Caddy's
  admin API.
- Deny reasons are coarse on purpose — they are logged, never returned to clients.
