# @fabrika/auth-core

The authz kernel every auth component shares: the policy model, the gate matcher, the access-token
claim shape, and the `IamRpc` contract. It is what stops IAM, the proxy, and the app SDK from
drifting apart, because all three read the same definitions instead of agreeing by convention.
Assumes the root CLAUDE.md.

Published (`publishConfig.access: public`), so it ships to npm with `@fabrika/auth`.

```bash
bun run typecheck
bun test               # gates.test.ts · permissions.test.ts · token.test.ts · ids.test.ts
```

| Module           | What it owns                                                                         |
| ---------------- | ------------------------------------------------------------------------------------ |
| `gates.ts`       | The canonical gate path matcher — `compileGates` / `applicableGates`.                |
| `permissions.ts` | `matchAction` and `permits` — the authorization decision itself.                     |
| `token.ts`       | The access-token claim shape, cookie/prefix/TTL names, `buildAccessClaims`/`parse…`. |
| `rpc.ts`         | `IamRpc`, `IamHandoffRpc`, and every input/result type they carry.                   |
| `types.ts`       | `AppSchema`, `Scope`, `PermissionEntry`, `AppGates` / `GateRule` / `GateKind`.       |
| `wire.ts`        | `PROXY_TOKEN_HEADER` — the header the proxy injects its verified token on.           |
| `ids.ts`         | UUIDv7 generation (RFC 9562 §6.2 monotonic variant).                                 |
| `json.ts`        | Structural readers for untrusted JSON, so claims narrow without an `as` cast.        |

## Invariants

- **BROWSER-SAFE AND DEPENDENCY-FREE, DELIBERATELY — including no `jose`.** This package is imported
  by IAM, the proxy, the app SDK, and browser contract packages alike, so it may import nothing.
  **Signing and verifying stay in the packages that own key material**: IAM signs, the proxy and the
  SDK each verify with their own `jose` verifier. What lives here is the _shape_ both sides agree on
  — `buildAccessClaims` assembles claims for a caller that will sign them, `parseAccessClaims`
  narrows a payload a caller has already verified. Adding a runtime dependency here breaks four
  consumers at once.
- **`IamRpc` is the contract BOTH transports implement byte-for-byte.** IAM's Cloudflare
  `WorkerEntrypoint` declares `implements IamRpc`; its Bun `/rpc/*` surface and the SDK's
  `HttpIamRpc` carry the same methods over HTTP. Consumers type their binding as `IamRpc` and never
  import IAM. Changing a method's shape here is a simultaneous change to the Worker, the HTTP
  transport, and every caller — make it in one commit or the two transports diverge silently.
- **The handoff RPC is a SEPARATE interface on purpose.** `exchangeAuthCode` lives on
  `IamHandoffRpc`, never on `IamRpc`, because only the proxy may turn a one-time code into a session
  and `IamRpc` is held by every SDK consumer. On Zerops that split is a real key boundary
  (`/auth/mint/*` vs `/rpc/*`, two secrets); on Cloudflare one entrypoint implements both, so the
  separation survives only as a type — see
  [ADR-0022](../../docs/decisions/0022-the-proxy-is-the-only-enforcement-point.md). Folding the
  method into `IamRpc` would remove even that.
- **The gate matcher here is CANONICAL, and there must never be a second one.** `compileGates`
  compiles `*` to `.*` — it crosses `/` — matches case-sensitively, and matches the raw pathname
  with no normalization. Those are exactly the three properties Caddy's path matcher does not share,
  which is why gate rules are never compiled into routes
  ([ADR-0010](../../docs/decisions/0010-gate-evaluation-stays-in-the-auth-service.md)). A second
  evaluator anywhere gates a slightly different set of requests than the app declared, silently, in
  the permissive direction.
- **`applicableGates` returns every match in declaration order; it does not decide.** Precedence,
  fall-through, and terminality belong to the caller (`@fabrika/proxy`). Keep the matcher a pure
  filter so the authorization truth table lives in one place with one test suite.
- **Wildcards stay patterns and are never pre-expanded.** `matchAction` and `permits` compare a
  pattern to an action at request time, so a grant written today covers an app registered tomorrow.
  Any code that expands `project.*` into a list has broken that property and is also now stale.
- **`permits` semantics are exact and load-bearing.** `scope === undefined` means scope-less and is
  satisfied only by entries with `scope === null`; a concrete scope is satisfied by a global entry
  or by one matching the same `(type, value)` pair. `can()` in the SDK is this function; do not
  reimplement it with "close enough" behaviour.
- **The claim parser must reject rather than coerce.** `parseAccessClaims` returns `null` on any
  malformed field. It runs on a payload whose signature has been checked but whose custom claims
  have not, so a lenient read is a trust bug, not a convenience.
- **UUIDv7 is generated caller-side, never in SQL,** and its ordering promise is strict: ids sort
  lexicographically in mint order within a generator, which is what makes keyset cursors over `id`
  correct for rows written in the same millisecond.

## Notes

- `json.ts` mirrors readers that also exist in `@fabrika/iam` and `@fabrika/proxy-contract`. That
  duplication is deliberate — the alternative is a runtime dependency, which the first invariant
  forbids.
- Several comments in `token.ts` and `rpc.ts` still say "propustka" and describe the pre-merge
  Cloudflare-Access world in the present tense. The wire names (`px_session`, `px_token`, `px_`)
  are durable and must not be renamed; the historical framing around them is not a description of
  current behaviour.
