# @fabrika/auth-core

The authz kernel every auth component shares: the policy model, the gate matcher, the access-token
claim shape, and the `IamRpc` contract. It is what stops IAM, the proxy, and the app SDK from
drifting apart, because all three read the same definitions instead of agreeing by convention.
Assumes the root CLAUDE.md.

Published (`publishConfig.access: public`), so it ships to npm with `@fabrika/auth`.

```bash
bun run typecheck
bun test               # app-environment · canonical-path · contract-canonical · endpoint-digest · endpoints · gates · permissions · requirement · sha256 · token
```

| Module                   | What it owns                                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `app-environment.ts`     | `appEnvironmentId` / `parseAppEnvironmentId` — the IAM id `<app>@<env>` — and `FABRIKA_IAM_APP_ID`, the name it travels under. |
| `canonical-path.ts`      | `isCanonicalPath` — the one rule every hop refuses a path by — and the raw request target readers.                             |
| `contract.ts`            | `ContractArtifact` — the compiled contract, types only — and its `EndpointTable` / `EndpointRow`.                              |
| `contract-canonical.ts`  | `canonicalizeArtifact` and `canonicalArtifactJson` — the one canonical form and its digest bytes.                              |
| `endpoint-digest.ts`     | `requirementDigest`, `contractDigest`, the `X-Fabrika-Endpoint` value, and `FABRIKA_CONTRACT_DIGEST`.                          |
| `endpoints.ts`           | The contract matcher — `assertNoAmbiguity`, `compileEndpointTable`, `planEndpoint`.                                            |
| `gates.ts`               | The canonical gate path matcher — `compileGates` / `applicableGates`.                                                          |
| `path-segment.ts`        | `parameterName` — the one `:name` segment rule the gate glob and endpoint tables share.                                        |
| `permissions.ts`         | `matchAction` and `permits` — the authorization decision itself.                                                               |
| `requirement.ts`         | `satisfies` — an endpoint requirement checked against a token's permissions — and `callerOf`, a token's caller kind.           |
| `sha256.ts`              | `sha256Hex` — synchronous SHA-256, for the digests checked where nothing may await.                                            |
| `token.ts`               | The access-token claim shape, cookie/prefix/TTL names, the size bound, `buildAccessClaims`/`parse…`.                           |
| `rpc.ts`                 | `IamRpc`, `IamHandoffRpc`, and every input/result type they carry.                                                             |
| `membership.ts`          | `IamMembershipRpc` — delegation grants, scope creation, membership and share links — and its input/result types.               |
| `types.ts`               | `AppSchema`, `Scope`, `PermissionEntry`, `AppGates` / `GateRule` / `GateKind`.                                                 |
| `wire.ts`                | The proxy→app header names, `FABRIKA_HOP_HEADERS` (every one, all stripped), the proxy secret and `proxySecretVariable`.       |
| `environment.ts`         | The `ENVIRONMENT` name rule, and `FABRIKA_IAM_ISSUER` — the one name an issuer travels under.                                  |
| `framework-variables.ts` | `FRAMEWORK_VARIABLE_NAMES` — the names only the platform writes — and `frameworkVariableReference`, a Zerops reference to one. |
| `json.ts`                | Structural readers for untrusted JSON, so claims narrow without an `as` cast.                                                  |

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
- **The membership RPC is a SEPARATE interface too.** `IamMembershipRpc` is what an application's IAM
  entrypoint serves on top of the SDK's `IamRpc` subset; a platform component implementing `IamRpc`
  does not implement it. Its requests carry the caller's own credential and never an actor.
- **A share-link token has no `ptype` and carries `link: { mount, chain }`.** `principalKind` reads the
  kind ADR-0022 rule 3 checks (`user`, `service`, `link`); a plain anonymous token has none, so no
  contract mount admits it. `parseAccessClaims` rejects a link claim next to a `ptype` or OAuth claims.
- **The handoff RPC is a SEPARATE interface on purpose.** `exchangeAuthCode` lives on
  `IamHandoffRpc`, never on `IamRpc`, because only the proxy may turn a one-time code into a session
  and `IamRpc` is held by every SDK consumer. On Zerops that split is a real key boundary
  (`/auth/mint/*` vs `/rpc/*`, two secrets); on Cloudflare one entrypoint implements both, so the
  separation survives only as a type — see
  [ADR-0022](../../docs/decisions/0022-the-proxy-is-the-only-enforcement-point.md). Folding the
  method into `IamRpc` would remove even that.
- **A handoff redemption includes a browser-held verifier.** The proxy sends only its S256 challenge
  through the browser-facing login flow, then submits the verifier privately with the one-time code.
  Keep `state`, the challenge, the dynamic cookie prefix, and their TTL in this shared wire contract.
- **The gate matcher here is CANONICAL, and there must never be a second one.** `compileGates`
  compiles `*` to `.*` — it crosses `/` — and a whole `:name` segment to exactly one non-empty
  segment (`path-segment.ts`, the rule endpoint tables use), matches case-sensitively, and matches
  the raw pathname with no normalization. Caddy's path matcher shares none of the glob's three
  properties (`*` across `/`, case, no normalization), which is why gate rules are never compiled
  into routes ([ADR-0022](../../docs/decisions/0022-the-proxy-is-the-only-enforcement-point.md)). A
  second evaluator anywhere gates a slightly different set of requests than the app declared,
  silently, in the permissive direction.
- **A non-canonical path never reaches a matcher.** `isCanonicalPath` refuses an empty segment, `.`
  or `..` (also encoded), an encoded `/` or `\`, a literal `\` and a percent escape that
  `decodeURIComponent` cannot decode, which one reader would decode and another refuse. The proxy
  and the application router both run it on the RAW path — before `new URL()`, which resolves dot
  segments — and answer 400. A trailing `/` is allowed and matched literally by every matcher
  (Sentry's `/api/<id>/envelope/` needs it); a router that dropped it would serve `/a` for a `/a/`
  that a gate `/a/*` admitted. Widening the rule, or normalizing a path anywhere, breaks that
  agreement.
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
- **The contract artifact is types only, and each reader parses it.** `ContractArtifact` is plain
  JSON; its zod schemas live where it is read (`@fabrika/app/contract` for the build,
  `proxy-core/manifest` for the proxy), as gate rules are parsed today. Every optional field is
  normalized to `null`, `[]` or `{}`, because two producers — `compileContract` over the evaluated
  module and the static reader over source — must emit the same artifact. Keep new fields that way.
  `SchemaShape` represents exactly the zod subset of `packages/check/CLAUDE.md`; extend the two together
  (`@fabrika/app`'s `schema-shape.ts` reads one into the other).
- **An artifact is canonical: declaration order never reaches it.** `canonicalizeArtifact` sorts every array
  whose order carries no meaning — `endpoints` by id, `reservedPrefixes`, role `grants` and `assignableBy`, RPC
  and endpoint `callers`, link `grants`, webhook and job `actions`, export `consumers`, import `procedures` and
  `usedBy`, file `types`, admission `contentTypes`, CSP sources by origin, table `insert`, `update` and
  `inherit`, enum `values` — by code unit. Only two arrays are ordered, because the order changes what a schema
  admits: tuple `items` and union `options`. `canonicalArtifactJson` also sorts object keys; it is the only
  serialization a digest of an artifact may be taken over. A new array field is unordered unless it is added to
  that list of two.
- **The contract matcher is a router, not a gate evaluator.** `planEndpoint` refuses a non-canonical
  raw path, then selects the most specific endpoint of the request's method: per segment, left to
  right, a literal beats a parameter and a parameter beats a terminal `*`. Under a reserved prefix
  only the endpoints declared under it compete, so an unknown procedure never reaches the SPA. There
  is no fall-through, and parameters come back raw. It evaluates no gate rule. Segments match like
  the gate glob: raw, case-sensitive, a trailing `/` literal, a non-root `*` only after its slash.
  The proxy and the framework both select with it, so a contract application has no gates: a gate
  list cannot express "no fall-through" or "the most specific endpoint wins" (ADR-0022 rule 3).
- **`planEndpoint` takes only a `compileEndpointTable` result.** Compiling runs `assertNoAmbiguity`
  — an invalid path or reserved prefix, a duplicate id, a parameter named `__proto__`,
  `constructor` or `prototype`, or two endpoints of one method and one path shape — so a request
  never meets a tie. Compile once where the table is loaded; never bypass it. It is generic over the row:
  selection reads only `id`, `method` and `path`, so the proxy compiles its manifest rows, which carry the rules
  but no schemas, with the same code.
- **The requirement check is authorization.** `satisfies(requirement, perms)` — `member` is any
  permission of the application; an action form is that action in some scope, including global,
  through `permits` over each entry's own scope. It never becomes a gate and never replaces one.
  Scopes stay flat here: the framework resolves a containment chain, and each link is checked as a
  flat scope.
- **An endpoint digest covers exactly what the proxy applies.** `requirementDigest` hashes the canonical JSON of
  the row's kind, method, path, callers, requirement, admission and delegation; callers and content types are
  sorted, and the id, source and schemas are not part of it. The delegation is derived from the artifact by
  `endpointDelegation` alone — the proxy table, the IAM schema's `delegations` and `endpointDigest` all call it. The proxy sends `<id>@<digest>` and the application recomputes it, so a
  new rule the proxy enforces must join the digest in the same change, or the two can disagree unnoticed.
  `contractDigest` is the digest of `canonicalArtifactJson`. Both are synchronous on purpose (`sha256.ts`): the
  manifest parser and `boot` check them, and neither can await WebCrypto.
- **`FABRIKA_HOP_HEADERS` lists every `X-Fabrika-*` name a proxy hop carries.** Caddy's first step and
  the Cloudflare proxy Worker delete exactly that list, so a header the proxy starts to set joins it in
  the same change; `wire.test.ts` fails on an `X-Fabrika-*` constant of `wire.ts` missing from it. The
  Operations upload headers stay out: a client sends them to Operations through the platform proxy.
- **The claim parser must reject rather than coerce.** `parseAccessClaims` returns `null` on any
  malformed field. It runs on a payload whose signature has been checked but whose custom claims
  have not, so a lenient read is a trust bug, not a convenience.

## Notes

- `json.ts` mirrors readers that also exist in `@fabrika/iam` and `@fabrika/proxy-core/manifest`. That
  duplication is deliberate — the alternative is a runtime dependency, which the first invariant
  forbids.
- Several comments in `token.ts` and `rpc.ts` still say "propustka" and describe the pre-merge
  Cloudflare-Access world in the present tense. The active wire names (`__Host-px_session`,
  `__Host-px_handoff_`, `px_`) are durable and must not be renamed; the historical framing around
  them is not a description of current behaviour. `token.ts` says "parent cookie domain" nowhere any more:
  ADR-0023 made every session cookie host-only and the `__Host-` prefix is the browser-enforced
  restatement of that — a cookie of either name carrying a `Domain` is DROPPED, not widened.
