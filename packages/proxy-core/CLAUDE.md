# @fabrika/proxy-core

The auth enforcement **decision**, as a runtime-neutral library: take a forwarded request, decide,
and mint or refuse. Nothing reaches an app until the endpoint the proxy selects admits the request
([ADR-0022](../../docs/decisions/0022-the-proxy-is-the-only-enforcement-point.md), which supersedes
0007/0008/0010/0021). Assumes the root CLAUDE.md.

There are two enforcement points and they run the same code from here: the Bun service answering
Caddy's `forward_auth` subrequest on Zerops (`@fabrika/proxy`), and the Cloudflare proxy Worker
calling it in-process (`@fabrika/provider-cloudflare`). The manifest wire contract and its strict
parser are `src/manifest.ts`, exported as `@fabrika/proxy-core/manifest`; the endpoint planner and the token claims are `@fabrika/auth-core`;
the JWKS token verifier is `@fabrika/jwks`, the same class `@fabrika/auth` wraps.

**The behavioural invariants live in [`../proxy/CLAUDE.md`](../proxy/CLAUDE.md)** — deny semantics,
the three-state `verify`, the answer shape of a `human` row, the client-coordinate table, and the
session handoff. They are properties of the decision, so they apply here; that file is not repeated.

## Commands (this package)

```bash
bun test   # deny-matrix (fail-closed), endpoint-matrix (application tables) and installation-matrix (installation entries) are the truth tables — keep them exhaustive
```

## Invariants

- **Runtime-neutral by construction.** No Caddy, no filesystem, no process, no `Bun.*`. If something
  here needs to know how it is deployed, it belongs in `@fabrika/proxy` or in the provider bundle.
  This is what lets one decision serve a Worker and a Bun process without a second implementation.
- **This package is PUBLIC; `@fabrika/proxy` is not.** The split exists because
  `@fabrika/provider-cloudflare` is published and needs the decision — it must never need the Caddy
  deployment. Anything added here becomes public API; the release gate (`bun run release:validate`)
  enforces the direction and the public inventory in `scripts/release.ts` is deliberate.
- **`@fabrika/proxy-core/manifest` imports only zod, `@fabrika/auth-core`, `./headers`, `./oauth-resource` and `./brand`.** Producers
  (providers, control, local-stack) import it without the decision, so never import `jose`, the
  verifier, or anything else from `src/` into `src/manifest.ts`. Malformed input never becomes a
  partially accepted manifest.
- **`@fabrika/proxy-core/headers` is the one definition of the response header policy and the file
  treatment** (ADR-0022), imported by the framework, Caddy's config and the Cloudflare Worker. It imports
  nothing at runtime, so the browser-safe `@fabrika/app/contract` can use `isPolicyOrigin`. Every answer
  `createVerifyService` writes for a request carries it — the contract app's policy (its metadata 404
  included), the file treatment when the request selects a `download` endpoint, the base policy otherwise
  (a 404 or 405 on the service itself included); the allow (a 204 to Caddy) and the liveness probe carry
  none. `appHeaderPolicy` and `appFileTreatment` add HSTS (`transportPolicy`) for an `https` entry, never for
  `http`; `headerPolicy`, `FILE_TREATMENT` and `BASE_HEADER_POLICY` never carry it, because only the manifest
  knows the public scheme. A producer of the proxy's answers uses the `app…` forms. A refusal before the request is
  read gets the base policy plus the transport of the application host it names (`earlyPolicy`). `applyHeaderPolicy`
  also deletes `REMOVED_RESPONSE_HEADERS` and `TRANSPORT_HEADERS` before it sets the policy, so an application's own
  HSTS never passes on `http`, nor any `Access-Control-*` header of its own; the Caddy config uses the same lists. A manifest CSP origin is an exact `https://` origin with a literal host (`new URL`
  accepts `*` in a host, so `isPolicyOrigin` checks the host itself), at most `MAX_CSP_ORIGINS` (16) per
  directive — the same bound the contract build applies.
- **A host is a NAME, never a pattern.** `isProxyHost` accepts a literal lower-cased LDH hostname
  (labels 1–63 chars, ≤ 253 total), and `proxyAppSchema` rejects the whole manifest when a host fails
  it. The manifest is the authority on hosts (ADR-0022), and Caddy's `host` matcher reads `*` as a
  wildcard label: on Zerops one proxy fronts every app in a namespace, so an accepted pattern captures
  the sibling apps' hostnames. Never relax it to accommodate a producer; fix the producer.
- **A navigation reads a page, every other caller the text** (`src/pages.ts`, ADR-0022's answers keep their status).
  `isPageNavigation` is `Sec-Fetch-Mode: navigate` exactly; unlike the login bounce, an absent header is NOT a
  browser here, so a client that sends none keeps reading `forbidden`. A page's text is fixed per status and names no
  deny reason, and its 403 says "does not exist, or no access", because a path no endpoint serves is a 403 too. A
  download endpoint's refusal stays the text: the file treatment makes every one of its answers an attachment. The
  callback refusal is always a page. Pages load nothing (no script, no external reference) and are served under the
  answer's own header policy; the same `errorPage` renders Caddy's own refusals and the Cloudflare Worker's failures.
- **`@fabrika/proxy-core/page-style` is the one stylesheet and frame of fabrika's own pages** (`src/page-style.ts`):
  the proxy's error pages, IAM's sign-in, account, invitation and consent pages, and Control's GitHub handoff, which
  adds only its steps. A page is the console's welcome set alone (`pageBody`): one panel in the middle of the window
  with the page's words at the left and the mark on the blueprint grid at the right, a plate in light and the
  welcome's dark panel in dark, and a footer under it, "Runs on [mark] fabrika" (IAM's words in its language) with the
  status at the right where the page has one. Buttons are the console's: outlined, the brand blue only on a form's first
  button. It imports nothing and loads nothing, and it repeats the console's tokens (`packages/dashboard/src/styles.css`)
  because it cannot read them: `page-style.test.ts` resolves the console's `light-dark()`, `var()` and `color-mix()`
  and fails on a drifted value, so change a colour in the console first and copy it here. Caddy serves it in a
  `static_response` body, so no `{` may be followed by a name. The footer links nowhere: the proxy's pages are read by
  an application's people, whom a link to fabrika would send to the wrong place for help.
- **`@fabrika/proxy-core/brand` is the one check of the installation's client logo** (`src/brand.ts`, ADR-0066): a
  PNG, WebP or SVG of at most `MAX_BRAND_IMAGE_BYTES` (32 KB) decoded, in canonical base64, whose leading bytes are
  what its type says (`brandImageProblem`). IAM's write, the manifest parser and the console's pre-check all run it, so
  a logo one admits the others admit; it imports only zod, so the browser can use it. `BRAND_IMAGE_TYPES` and
  `brandImageBase64` (the canonical spelling the check requires) are the one type list and the one encoder. The manifest's optional top-level
  `brand` is the installation's, the same on every host; a page shows it on the grid in place of the mark
  (`pageArt`), as an `<img>` of a `data:` URI and never as markup, with a `<source>` for a dark page, and the footer
  still names fabrika. A producer sends `brand` only to a proxy whose parser knows the key: an older one refuses it.
- **Every `catch` maps to a deny.** Nothing in `src/authorize.ts` returns an allow on an unexpected
  condition. A request that selects no endpoint is denied (403 `no_endpoint`).
- **The request being authorized is described ENTIRELY by the forwarded headers.** Never read the
  incoming request's own method or path; a missing `X-Forwarded-Uri` or `X-Forwarded-Method` must
  deny, not fall back.
- **The forwarded path is checked RAW, before any URL is built.** `isCanonicalPath` from
  `@fabrika/auth-core` runs on the header's path; a non-canonical one is a 400 (`non_canonical_path`)
  before any endpoint is planned. Assigning a pathname resolves `..` and `%2e%2e`, so checking after it
  would match `/admin` while the upstream receives `/a/../admin`.
- **The token cache is best-effort and per-process.** Every entry is re-verified against the JWKS
  before it is trusted, and `null` (no cache) is a supported configuration that changes only how many
  times IAM is called — never which requests are allowed. ADR-0022 requires the proxy to stay
  stateless, so never make it shared or persistent.
- **There is exactly one enforcement decision, and it is `src/authorize.ts`.** It composes
  `@fabrika/auth-core`'s planner (`planEndpoint`), `callerOf` and `satisfies`; it does not reimplement or
  extend them. A whole `:name` segment matches exactly one non-empty segment, a terminal `*` the rest of
  the path. Array order carries no meaning: the most specific endpoint wins.
- **A manifest app is exactly one of two forms.** `endpoints` (with `reservedPrefixes`, `snapshot` and
  `csp`) makes a contract app — an application; `installation: true` with `endpoints` makes an
  installation entry (ADR-0022 "Installation entries"). Both schemas and `proxyManifestSchema` are
  `.strict()`: a `gates` key, OAuth resources beside an application's table, an `installation` key on a
  contract app, or any other unknown key refuses the whole manifest, never read as one of the forms.
  `isApplicationEntry` is the one predicate every hop rule keys on (proxy secret, header policy, the
  `Authorization` delete, metadata routes); everything else is an installation service. A request is one
  pass over the row `planEndpoint` selects (ADR-0022 rule 3), with no fall-through: no row → 403; a
  presented `Authorization` header is a `px_` key and terminal, and its caller kind (`callerOf`,
  re-checked on cached tokens) must be one of the row's callers, and an `app:<id>` caller must be on an
  export path (`callerAdmittedAt`) → 403; a job or webhook key is no caller kind, so every row refuses
  it; no key and no `human` caller → 401, never a bounce; the session or the login bounce; `satisfies` →
  403; admission (a session non-`GET` needs `Sec-Fetch-Site: same-origin` → 403, the media type must be
  one the row admits → 400). An anonymous kind (`health`, `webhook`, `public`, a 0.4/0.5/0.6 `form`) reads no credential
  and mints no token. The allow carries `X-Fabrika-Endpoint: <id>@<digest>`. A `webhook` row with `authorization:
  'forward'` (a `basic` or `bearer` verifier) adds `X-Fabrika-Forward-Authorization: 1` when the request's
  `Authorization` goes on to the app, never when it carries `px_` (`carriesPlatformKey`, Basic credentials decoded).
- **The rows of the surface revision are new kinds or absent fields.** The `public` kind and the `capabilities`
  requirement (every named action in some scope) are new; a row's `response: 'file'` (the file treatment of
  `headers.ts` on every answer) and a public `GET` row's `cache` join the digest only when present. So every 0.4/0.5/0.6
  row keeps its digest, and an older proxy's strict parser refuses the new forms instead of serving them without their
  rule (ADR-0022).
- **The installation-only forms exist in installation entries alone.** The parser refuses `protocol`,
  `service`, method `*`, caller `oauth`, requirement `authenticated` and an `oauth` row field in an
  application row; and an installation entry whose id holds `@`, that carries `snapshot`, `csp` or
  `operationsOrigin`, or whose `oauth` row has no registered resource on its path (`oauthResourceOfRow`)
  or asks for an unsupported scope. On a row that admits `oauth`, a bearer that is not a `px_` key (or
  no bearer, when `human` is not a caller) takes the RFC 6750 path (`verifyOAuthBearer`): local verification for the row's resource, every row scope, the challenge on
  401/403, never a bounce; a refused `px_` key there keeps its status and reason and gets the challenge too
  (`withBearerChallenge`). A `protocol` row reads no credential like any anonymous kind; only its hop
  differs.
- **A cross-origin request is decided from the row and the entry, never by the application** (ADR-0022 "Cross-origin
  endpoints"). A contract application's row may carry `crossOrigin` (`environment` on a `query`, `mutation`, `public`
  or a 0.4/0.5/0.6 `form`; `any` on a `public` or `form` row only; a procedure declares it as `admission.origins`), and
  its entry `crossOrigins`, the environment's exact origins (`isCrossOrigin`, at most
  `MAX_CROSS_ORIGINS`, each once, never one of its own hosts); the parser refuses either anywhere else. An `OPTIONS`
  with `Origin` and `Access-Control-Request-Method` is a preflight, planned for the REQUESTED method before any
  credential is read (`decidePreflight`): an admitted one is the `preflight` outcome, a 204 carrying the policy,
  `preflightHeaders` and `PREFLIGHT_HEADER`, which both compositions return as the whole answer without dialling the
  app; anything else is 403 (`cross_origin`, or `no_endpoint`). An installation entry's `OPTIONS` is an ordinary
  request. On any other request `admittedOrigin` gives the allow's `crossOrigin` (copied by the composition onto the
  app's answer with `applyCrossOriginHeaders`) and a denial's (set on it directly). A `public` row's multipart or `urlencoded` request, and a 0.4/0.5/0.6
  form row that admits `multipart/form-data`, is refused when its `Origin` is neither the entry's own
  (`<scheme>://<host>`) nor admitted (`admitFormOrigin`, 403 `cross_origin`): a browser sends those types without a
  preflight. A request without `Origin` passes; `Origin: null` does not (ADR-0022's browser admission matrix). A listed origin's request is never
  session-authenticated: without `Authorization` it is 401 `no_credential`, never a bounce. No answer carries
  `Access-Control-Allow-Credentials`.
- **A workload key opens no `machine` row.** The caller `machine` admits only a `service` key: a key whose token has
  a workload kind (`job`, `webhook`, `app`) is 403 `caller_kind` there, also from the cache (ADR-0022 "Principal
  kinds").
- **A row's digest is checked where the manifest is parsed.** The parser recomputes
  `requirementDigest` and refuses a row whose digest differs, so the digest the proxy sends always
  describes the rules it applied. Producers build rows with `contractProxyTable(artifact)` for an
  application and `serviceProxyTable(service, { oauth })` for an installation service's contract, never
  by hand. Without an authorization server (`oauth: false`) `serviceProxyTable` drops every row that
  admits `oauth`; the service must then serve the same table, or that path answers 503 there. A contract
  application's whole entry (placement, table, `operationsOrigin`, `crossOrigins`) is built by
  `contractProxyEntry`, which refuses what `contractProxyAppSchema` refuses and names the field, never its value.
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
