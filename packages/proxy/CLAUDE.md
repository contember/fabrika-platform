# @fabrika/proxy

The **Caddy deployment** of the auth enforcement point: the configuration that fronts the decision
service, plus the Bun process that serves it. Nothing reaches an app until its gates pass
([ADR-0022](../../docs/decisions/0022-the-proxy-is-the-only-enforcement-point.md), which supersedes
0007/0008/0010/0021). Assumes the root CLAUDE.md.

**The decision itself is [`@fabrika/proxy-core`](../proxy-core/CLAUDE.md)** — runtime-neutral, public,
and shared verbatim with the Cloudflare proxy Worker. This package is an ARTIFACT rather than an API
and stays `private: true`: `bun run build` compiles `src/main.ts` into a static musl binary with
`caddy.json` beside it. The manifest wire contract and its strict parser live in
`@fabrika/proxy-contract`; the gate matcher and its compiled form live in `@fabrika/auth-core`.

Most of the invariants below are properties of the DECISION and therefore hold in `proxy-core`; they
are documented here because this is where the enforcement point is described end to end. What is
specific to this package is the Caddy configuration, `src/env.ts`, and the process lifecycle.

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
  Browser authentication starts from the host-only opaque `__Host-px_session`; the short-lived JWT
  exists only in the proxy cache and the injected header. Share links are redeemed OFF the gate path.
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
- **The generated Caddy config strips the token header, the request id AND every name a client address
  travels under from the inbound request before `forward_auth` runs** (the Cloudflare Worker does the
  same). Caddy's `copy_headers` skips empty values rather than deleting, so without the strip a client
  could present its own token header on a `public` path and have it reach the app — and the request id
  it chose would land in IAM's `auth_log` and `audit_events`. The token and the request id are written
  back from the auth response on a 2xx; the client address is not, because it describes the request as
  the EDGE saw it and no inner hop gets a vote. A header a client can set never reaches a decision.
- **Gate rules are NOT compiled into Caddy routes** — every request goes to `/verify` and gates are
  evaluated once, in TypeScript. Caddy's `path` matcher is case-insensitive, its `*` stops at `/`,
  and it normalizes the path; the SDK's glob does none of those, and fall-through is not expressible
  as a matcher at all. Any of those mismatches silently widens or narrows an authorization rule. Read
  the header of `src/caddy.ts` before revisiting this.
- **Gate semantics are `AppGates`', verbatim:** array order IS precedence; a matching rule whose
  credential is ABSENT falls through; a matching rule whose credential is PRESENT is terminal. A
  rejected human session therefore never falls through to a later public or service rule.
- **The token cache is best-effort and per-process.** Every entry is re-verified against the JWKS
  before it is trusted, and `null` (no cache) is a supported configuration that changes only how many
  times IAM is called — never which requests are allowed. ADR-0022 requires the proxy to stay
  stateless, so never make it shared or persistent.
- **`verify` is three-state.** "This token is bad" (401/403) and "we could not check" (503) are
  different denials. Both deny; only the second is an incident — including on the human path, where a
  503 must NOT degrade into a bounce to login (that is a login loop hiding an outage). A cache entry
  is dropped only when it PROVED bad, never when it merely could not be checked.
- **Refusing to boot beats booting misconfigured** (`src/env.ts`). `FABRIKA_IAM_ISSUER` and
  `FABRIKA_IAM_KEY` are both REQUIRED — IAM's mint surface 404s without the key, so a proxy that boots
  without one 503s everything. The key is the only secret here: read once, never logged, never echoed,
  never put in a URL. `FABRIKA_IAM_ISSUER` is canonicalized to an ORIGIN once, in `readProxyEnv`, because
  the same string is compared byte-for-byte against a token's `iss` and used to build URLs. **This
  holds on the Bun path only.** The Cloudflare proxy Worker does not call `readProxyEnv`: it refuses
  a missing `IAM` binding and an empty manifest, but reads `FABRIKA_IAM_ISSUER ?? ''`, so a misconfigured
  issuer boots and fails every verification on `iss` instead.
- **The manifest is the authority on hosts.** `parseProxyManifest` rejects two apps claiming one host
  and a host carrying a `:port` — not just `buildCaddyConfig`, which only sees the manifests it
  generates from. A pinned `?app=` is additionally cross-checked against that app's declared hosts,
  because `X-Forwarded-Host` is client-controllable and then builds URLs.
- **If the auth service dies, Caddy answers 502 and every request is denied.** `start.sh` restarts it
  in a loop; that failure mode is by design, not a gap to paper over.

## The client coordinate — who owns which header, at every hop

The proxy is the only hop that can see the real client, so it is the only one that may say who it was.
It observes and injects; it holds no counter (ADR-0022 forbids proxy state a decision depends on, and
a per-isolate counter on Cloudflare would be defeated by the next colo anyway). The upstream that owns
the state — IAM — keys its per-client abuse bucket on what arrives. Backlog 21 + 49.

| Hop                        | `X-Fabrika-Client-Ip`                         | `X-Forwarded-For`              | `CF-Connecting-IP`         |
| -------------------------- | --------------------------------------------- | ------------------------------ | -------------------------- |
| client → edge              | may send it; means nothing                    | may send it; means nothing     | may send it; means nothing |
| Cloudflare edge            | passed through untouched                      | client value + the real client | **written by the edge**    |
| Cloudflare proxy Worker    | **deleted, then set** from `CF-Connecting-IP` | deleted                        | deleted                    |
| Zerops balancer            | passed through untouched                      | unconfirmed — see below        | passed through untouched   |
| Caddy (`appRoute`, step 1) | **deleted, then set** from `{client_ip}`      | deleted                        | deleted                    |
| app / IAM upstream         | trust it — nothing else could have written it | the previous hop's socket peer | absent                     |

- **`{http.request.client_ip}` is the socket peer unless `trusted_proxies` names the balancer.** Caddy
  resolves it once in `PrepareRequest`, before any handler, so the strip above cannot affect it. With
  no range configured every client behind the balancer shares one bucket — which is exactly what
  happened before this existed, and the only safe fallback. `CaddyBuildOptions.trustedProxies` /
  `--trusted-proxies` / `FABRIKA_PROXY_TRUSTED_PROXIES` set it; it is **empty by default and staying
  that way until a live Zerops account settles whether the project balancer appends an address a
  downstream may trust.** Configuring the wrong range makes the limiter caller-chosen, which is worse
  than none.
- **Setting `trusted_proxies` also makes `X-Forwarded-Host`/`-Proto` client-supplied**, because Caddy
  retains a prior value when the immediate peer is trusted (`addForwardedHeaders`, v2.10.2). The proxy
  already defends both — `selectApp` cross-checks a pinned `?app=` against the app's declared hosts,
  and the login bounce takes its scheme from the manifest — but nothing new may start trusting them.
- **`CF-Connecting-IP` is deleted on the way to an app even on Cloudflare, where it is genuine.** One
  header with one meaning on both clouds beats a provider-specific one that silently means "a caller
  wrote this" on the other. IAM's own Worker is the exception and reads it directly — it holds its own
  Custom Domain and is not behind a proxy Worker, so the edge is the hop in front of it.
- **A rate limiter is admission control, not authorization.** It lives nowhere near the gate matcher
  and must never grow gate semantics; there is still exactly one gate evaluator, in
  `@fabrika/auth-core`.

## The session handoff (ADR-0022, ADR-0023)

- **The proxy writes a long-lived app session on EXACTLY ONE path**: successful redemption at the
  reserved callback. Starting login additionally writes one short-lived browser verifier cookie,
  named `__Host-px_handoff_<state>` so parallel tabs do not overwrite each other; the callback clears
  it on every terminal outcome. IAM receives only its S256 challenge. A callback without the matching
  state and verifier cannot redeem or replace a browser's session.
- **Fabrika cookies stop at the proxy.** Caddy and the Cloudflare proxy Worker remove every
  `__Host-px_*` cookie only from the request sent upstream. Application-owned cookies remain intact;
  the app receives identity through the verified `X-Fabrika-Token` header only.
- **The session cookie's attributes are fixed by its `__Host-` prefix**: `Secure`, `Path=/`, no
  `Domain`. `Secure` is UNCONDITIONAL and no longer follows `ProxyApp.scheme` — the prefix requires
  it, so a conditional could only emit a cookie the browser discards. It is right behind a
  TLS-terminating balancer (plain HTTP socket, HTTPS browser) and on `*.localhost`, which browsers
  treat as potentially trustworthy; measured in Chromium 151, not assumed.
- **`/__fabrika/auth/callback` is reserved on every app host** and is answered BEFORE gate matching —
  it is how a browser becomes able to satisfy a gate, so it cannot be behind one. It must not shadow
  an application route, the same hazard `src/caddy.ts` documents for the health route. Its `?code=`
  and `?state=` are stripped from structured request logs; the Cloudflare proxy disables automatic
  invocation logs because they would otherwise capture the raw callback URL.
- **`ProxyApp.scheme` is configuration no header may supply.** A TLS-terminating balancer forwards
  plain HTTP and the next hop rewrites `X-Forwarded-Proto` to what _it_ received, so the login bounce
  and the callback are built from the manifest. Absent parses as `https`.

## Patterns

- `src/generate-config.ts` runs at BUILD time: `proxy.manifest.json` → `caddy.json`, baked into the
  artifact, so a gate change ships with the app's next deploy rather than being pushed to Caddy's
  admin API.
- Deny reasons are coarse on purpose — they are logged, never returned to clients.
