# @fabrika/proxy

The **only** auth enforcement point: a Bun service answering Caddy's `forward_auth` subrequest, and
the same code called in-process by the Cloudflare proxy Worker. Nothing reaches an app until its
gates pass ([ADR-0022](../../docs/decisions/0022-the-proxy-is-the-only-enforcement-point.md), which
supersedes 0007/0008/0010/0021). Assumes the root CLAUDE.md. The
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
- **A `human` gate admits only `ptype: 'user'`.** A valid token is not a human: `issueJwt` signs an
  anonymous token for the app (up to 24 h, not revocable) and `mintFromKey` signs `ptype: 'service'`.
  `px_token` is client-supplied — the proxy only ever writes `px_session` — so every tier of
  `authorizeSession` checks the claim. Share links are redeemed OFF the gate path.
- **A `human` gate miss answers in the shape the caller can act on.** `Sec-Fetch-Mode: navigate`, or
  the header absent, → the 302 bounce; any other value → **401** with
  `{ error: { type: 'auth', message, loginUrl } }`, the envelope `@fabrika/app`'s browser RPC client
  bounces on. A redirect a page's `fetch` cannot follow is an opaque failure, and a 302 turns an
  in-flight POST into a bodyless GET. The signal is `Sec-Fetch-Mode` and not `Accept` because `Sec-`
  is a forbidden header prefix — the browser states it and page JS cannot, so it describes the caller
  instead of letting the caller choose the answer. Both forms carry the SAME login URL (`app=` +
  `redirect=`, ADR-0022). Verified against caddy 2.10.2: `forward_auth` forwards `Sec-Fetch-*`
  verbatim and returns a non-2xx auth response — status, `Content-Type` and body — to the client.
- **The service binds to LOOPBACK.** It answers "is this request allowed" and hands back a signed
  token, so a publicly routable instance is a token oracle. Caddy is the only thing that may dial it.
- **The request being authorized is described ENTIRELY by the forwarded headers.** Never read this
  request's own method or path; a missing `X-Forwarded-Uri` must deny, not fall back.
- **The generated Caddy config strips the token header AND the request id from the inbound request
  before `forward_auth` runs** (the Cloudflare Worker does the same). Caddy's `copy_headers` skips
  empty values rather than deleting, so without the strip a client could present its own token header
  on a `public` path and have it reach the app — and the request id it chose would land in IAM's
  `auth_log` and `audit_events`. Both are written back from the auth response on a 2xx. A header a
  client can set never reaches a decision.
- **Gate rules are NOT compiled into Caddy routes** — every request goes to `/verify` and gates are
  evaluated once, in TypeScript. Caddy's `path` matcher is case-insensitive, its `*` stops at `/`,
  and it normalizes the path; the SDK's glob does none of those, and fall-through is not expressible
  as a matcher at all. Any of those mismatches silently widens or narrows an authorization rule. Read
  the header of `src/caddy.ts` before revisiting this.
- **Gate semantics are `AppGates`', verbatim:** array order IS precedence; a matching rule whose
  credential is ABSENT falls through; a matching rule whose credential is PRESENT is terminal.
- **The token cache is best-effort and per-process.** Every entry is re-verified against the JWKS
  before it is trusted, and `null` (no cache) is a supported configuration that changes only how many
  times IAM is called — never which requests are allowed. ADR-0022 requires the proxy to stay
  stateless, so never make it shared or persistent.
- **`verify` is three-state.** "This token is bad" (401/403) and "we could not check" (503) are
  different denials. Both deny; only the second is an incident — including on the human path, where a
  503 must NOT degrade into a bounce to login (that is a login loop hiding an outage). A cache entry
  is dropped only when it PROVED bad, never when it merely could not be checked.
- **Refusing to boot beats booting misconfigured** (`src/env.ts`). `FABRIKA_IAM_URL` and
  `FABRIKA_IAM_KEY` are both REQUIRED — IAM's mint surface 404s without the key, so a proxy that boots
  without one 503s everything. The key is the only secret here: read once, never logged, never echoed,
  never put in a URL. `FABRIKA_IAM_URL` is canonicalized to an ORIGIN once, in `readProxyEnv`, because
  the same string is compared byte-for-byte against a token's `iss` and used to build URLs. **This
  holds on the Bun path only.** The Cloudflare proxy Worker does not call `readProxyEnv`: it refuses
  a missing `IAM` binding and an empty manifest, but reads `FABRIKA_IAM_URL ?? ''`, so a misconfigured
  issuer boots and fails every verification on `iss` instead.
- **The manifest is the authority on hosts.** `parseProxyManifest` rejects two apps claiming one host
  and a host carrying a `:port` — not just `buildCaddyConfig`, which only sees the manifests it
  generates from. A pinned `?app=` is additionally cross-checked against that app's declared hosts,
  because `X-Forwarded-Host` is client-controllable and then builds URLs.
- **If the auth service dies, Caddy answers 502 and every request is denied.** `start.sh` restarts it
  in a loop; that failure mode is by design, not a gap to paper over.

## The cross-host handoff (ADR-0022)

- **The proxy sets a cookie on EXACTLY ONE path**: a successful redemption at the reserved callback,
  and nowhere else. It is otherwise a pure enforcement point; every extra write site is another place
  a mistake establishes a session.
- **`/__fabrika/auth/callback` is reserved on every app host** and is answered BEFORE gate matching —
  it is how a browser becomes able to satisfy a gate, so it cannot be behind one. It must not shadow
  an application route, the same hazard `src/caddy.ts` documents for the health route. Its `?code=` is
  a bare random token, so the access-log redaction pattern carries it unconditionally: it is not a
  declared credential and nothing else would ever contribute it.
- **`ProxyApp.scheme` is configuration no header may supply.** A TLS-terminating balancer forwards
  plain HTTP and the next hop rewrites `X-Forwarded-Proto` to what _it_ received, so the login bounce
  and the callback are built from the manifest. Absent parses as `https`.

## Patterns

- `src/generate-config.ts` runs at BUILD time: `proxy.manifest.json` → `caddy.json`, baked into the
  artifact, so a gate change ships with the app's next deploy rather than being pushed to Caddy's
  admin API.
- Deny reasons are coarse on purpose — they are logged, never returned to clients.
