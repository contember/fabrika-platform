# Sprint — Auth hardening: make the proxy the only front door

**Theme.** A comprehensive review of `iam` / `proxy` / `auth` / `auth-core` produced 63 findings. The
single decision that shapes the rest is **backlog 18** (shipped and deleted by WU-A; its text is at
`52c916c^`): the app SDK still carries a complete second enforcement path, and 15 findings live in
code that is supposed to be deleted. So the sprint's goal is the one ADR-0007 stated and never finished — **the proxy is
the only thing that enforces, and every installation is secure by default** — plus the security and
correctness debt the review surfaced along the way.

No backward compatibility is required. Every consumer of this code is in this repo or is a
first-party app the same team ships.

## What IAM and the proxy are FOR

The whole subsystem exists to do two things:

1. **Shield an application from authentication entirely.** An app should never see a login, a
   session, a cookie, an SSO round trip, or a token exchange. It receives a request that has already
   been decided on, plus a verified statement of who is calling.
2. **Make authorization simple.** One vocabulary the app declares (`AppSchema`), one question the app
   asks (`can(action, scope)`), one place the answer comes from.

Everything in these packages is judged against that. **Every mechanism must be safe — and there must
be no more mechanism than the job needs.** The project is WIP: where an ADR records a decision that
later work invalidated, consolidate it rather than preserving a chain of corrections a reader has to
replay. Where two mechanisms do one job, delete one.

Three things fail that test today, and this sprint removes them:

- **Two enforcement paths** — the proxy and the SDK both evaluate gates. WU-A.
- **Two dev bypasses** — IAM's `LOCAL_DEV_LOGIN` and the SDK's `DEV` persona path, which is a second
  authentication model that exists only locally and is where a total silent bypass was hiding
  (SEC-4). WU-K.
- **Two admin transports** — `/admin/rpc` and ~24 REST operations, of which only four have a caller.
  WU-L.

## Load-bearing facts, re-verified at HEAD (`30da7b8`)

| #  | Fact                                                         | Evidence                                                                                                                                                                                                                                                  |
| -- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1  | ✔ The SDK enforces gates in-process on every provider        | `packages/auth/src/session.ts:93` `authenticate()`, wired at `packages/auth/src/iam.ts:388`                                                                                                                                                               |
| 2  | ✔ Only three consumers use that path                         | `control/src/iam.ts:169`, `operations/src/app.ts:67`, `examples/app/src/app.ts:15`                                                                                                                                                                        |
| 3  | ⚠ **The local stack does not gate the control plane at all** | `local-stack/src/prepare.ts:110` gives `vozka` `{ path: '/*', kind: 'public' }`, while `control/fabrika.config.ts:31` defines the real `CONTROL_PROXY_GATES`. Locally the SDK is the ONLY enforcement — deleting it without fixing this opens the console |
| 4  | ✔ `apiKeyMiddleware` has no caller                           | grep over `packages/` + `examples/`; Operations parses the ingest envelope itself (`operations/src/ingest.ts`)                                                                                                                                            |
| 5  | ✔ `redeemKey` must survive                                   | backlog 18: share links are redeemed OFF the gate path; it is reached through `capabilityMiddleware` today (`auth/src/iam.ts:465`)                                                                                                                        |
| 6  | ✔ The proxy never checks `ptype`                             | `proxy/src/authorize.ts:211` accepts any token whose signature, `iss`, `aud` and `exp` hold; `auth-core/src/types.ts:101` defines a `human` gate as "a resolved user principal exists"                                                                    |
| 7  | ✔ Anonymous `px_` credentials carry no app                   | `credentials` has no `app` column in either migration set; `tokens.ts:142` ignores its `app` argument on that branch                                                                                                                                      |
| 8  | ✔ The handoff code is logged verbatim                        | `proxy/src/caddy.ts:283` redacts only `px_…` and declared query credentials; the ADR-0021 code is a bare `randomToken(32)` on `?code=`                                                                                                                    |
| 9  | ✔ Email identity forks                                       | `normalizeEmailIdentity` governs the password path; `db.ts:239` `getUserByEmail` is `WHERE email = ?` and `idx_principals_uq_email` is case-sensitive in both engines                                                                                     |
| 10 | ✔ ADR-0021's persistence never runs on Postgres              | `postgres-schema.test.ts` calls no `HandoffRepository` method; `consumeCode`'s at-most-once guarantee rests on `changes === 0`, which on Postgres comes from string-matching a command tag                                                                |

## Work units

Ownership is by FILE, so units in one wave never touch the same file.

### Wave 1

**WU-A — Shrink the SDK to verification only** · large · closes backlog 18
The SDK stops enforcing: no gate evaluation, no session→token exchange, no cookie writes, no login
bounce. What stays is reading the proxy-injected `X-Fabrika-Token`, verifying it locally against the
JWKS, building an `AuthContext`, and `redeemKey` for share links.
_Verify first:_ `grep -rn "authMiddleware\|PropustkaAuth" packages examples` — exactly three consumers.
_Acceptance:_ `session.ts` is gone; no export can enforce a gate in-process; `redeemKey` still works;
control, operations and the example app authenticate off the injected token; `bun run typecheck` and
`bun test` green.
_Touch points:_ `packages/auth/src/**`, `packages/auth/CLAUDE.md`, `packages/control/src/iam.ts`,
`packages/operations/src/app.ts`, `examples/app/src/app.ts`.
_Folds in:_ SEC-4, SEC-18, SEC-19, SEC-34, SEC-35, SEC-36, CORR-2 (SDK half), CORR-3, COMP-2, COMP-3, ARCH-4, TEST-5, TEST-6.

**WU-B — Proxy hardening** · medium
_Acceptance:_ a `human` gate admits only `ptype: 'user'`; the handoff code never reaches an access
log; a JWKS/IAM outage is a 503 and not a bounce to login; `FABRIKA_IAM_KEY` is required to boot.
_Touch points:_ `packages/proxy/src/**`, `packages/proxy-contract/src/**`, `packages/proxy/CLAUDE.md`.
_Folds in:_ SEC-1, SEC-5, SEC-15, SEC-16, SEC-17, SEC-21, SEC-32, SEC-33, CORR-2, CORR-6, CORR-7, ARCH-3, ARCH-6, TEST-4, DOC-2, COMP-5.

**WU-C1 — One mailbox rule + the handoff's remaining edges** · large
_Acceptance:_ an OIDC login differing only in case resolves to the invited principal; a mixed-case
`FABRIKA_IAM_HUMAN_EMAILS` entry matches; an empty return-origin registry no longer strands a
cross-host sign-in; the OIDC flight cookie is authenticated.
_Touch points:_ `packages/iam/src/auth/**`, `oidc.ts`, `handoff.ts`, `auth.ts`, `password-*.ts`,
`resolve.ts`, the email + return-origin queries in `db.ts`, the invite/create/setReturnOrigins use
cases in `admin/handlers.ts`, both migration sets.
_Folds in:_ SEC-6, SEC-9, SEC-12, SEC-14, SEC-23, SEC-24, SEC-25, SEC-26, SEC-31, CORR-1, DOC-3, TEST-11.

### Wave 2

**WU-C2 — Tokens, admin surface, cron** · large · after C1 (shares `db.ts` / `handlers.ts`)
_Acceptance:_ an anonymous `px_` credential mints only for the app it was issued for; an app deploy
cannot overwrite an admin's `origin='custom'` policy; `sessions` is pruned; no admin RPC procedure
can lose its gate silently.
_Touch points:_ `packages/iam/src/admin/**`, `db.ts`, `tokens.ts`, `issue.ts`, `cron.ts`, `secret.ts`,
`rpc.ts`, both migration sets, `packages/iam-contract/src/index.ts`.
_Folds in:_ SEC-2, SEC-3, SEC-7, SEC-8, SEC-11, SEC-13, SEC-22, SEC-27, SEC-28, SEC-29, CORR-4, CORR-5, CORR-8, CORR-9, CORR-10, COMP-4, COMP-6, ARCH-1, TEST-7, TEST-8, TEST-10, TEST-12 — plus the **OIDC boot asymmetry** carried in from the Zerops handoff: missing OIDC configuration is fatal at boot on the Bun path and silently tolerated on Workers. Unify on fatal.

**WU-D — Secure by default in the local stack** · small · after A
The local platform manifest must carry the same gates the production graph does. Fact 3 above.
_Acceptance:_ `bun run local:up` fronts the console with real gates; an unauthenticated request to
`/api/*` is refused by the proxy, not by the app.
_Touch points:_ `packages/local-stack/src/prepare.ts`, `packages/local-stack/CLAUDE.md`, `tests/browser/`.

**WU-K — One dev bypass, not two** · medium · after A and D
The SDK's `DEV` path (`FakeIamClient`, `PersonaSpec`, `devDefaultPersona`, `devLoginHandler`, the
`?__as=` / cookie / header selector) is a **second authentication model** that exists only locally.
It is where SEC-4 hid — a total silent bypass reachable from one mistyped env var — and it exists
only because local development did not run the real stack. After WU-D it does: the local stack runs
real IAM behind the real proxy, and IAM already has its own bypass (`LOCAL_DEV_LOGIN`, refused at use
once the flag is off).
_Verify first:_ with WU-D applied, sign in to the local console through the real proxy and IAM.
_Acceptance:_ one dev bypass in the system, in IAM, gated by `ENVIRONMENT=local`. `createIam` takes no
`DEV` at all. Local development still works with no manual token wrangling.
_Touch points:_ `packages/auth/src/{iam,fake}.ts`, `packages/control/src/iam.ts` (the persona roster
and `X-Dev-Principal`), `packages/operations/src/*`, `packages/local-stack/**`, `tests/browser/`.
_Folds in:_ what remains of SEC-4 after WU-A.

### Wave 3

**WU-E — `__Host-` cookie prefix** · medium · coordinated across auth-core, proxy, iam (SEC-20)
**WU-F — Cover the ADR-0021 path** · medium · TEST-1, TEST-2, TEST-3
**WU-G — Project return origins from the control plane** · medium · closes **backlog 51** (shipped and
deleted in `9d7396d`; its text is at `9d7396d^`)

**WU-M — A gate miss must be answerable by a fetch, not only by a browser** · small
`authorize.ts` returns a 302 for every `human` gate miss. For a document navigation that is
right. For the console's own XHR it is not: an expired session turns an RPC POST into a
cross-origin redirect to IAM that the SPA's `fetch` cannot follow, so the user sees an opaque
failure instead of a sign-in. The dashboard already knows how to handle this — `bounceOnAuth`
in `packages/app/src/client.ts` acts on a 401 carrying `loginUrl` — but nothing emits that
shape any more now that the SDK no longer does (WU-A).
_Acceptance:_ a non-navigation request that misses a `human` gate gets a 401 whose body carries
the login URL, and a document navigation still gets the 302. Decide the signal from what the
proxy can actually observe (`Sec-Fetch-Mode`, `Accept`) and pin it in the deny matrix. An
expired console session must produce a sign-in, not a broken page.
_Touch points:_ `packages/proxy/src/{authorize,service}.ts`, its tests, `packages/dashboard`.

**WU-L — Collapse the admin surface to one transport plus a provisioning API** · medium
`packages/iam/src/admin/router.ts` serves ~24 REST operations mirroring `/admin/rpc`. Verified
callers of the REST half, repo-wide: `PUT|GET /admin/apps/:app/schema` (`reconcileSchema`, a
deploy-time HTTP call that genuinely cannot use a binding) and `POST|DELETE /admin/api-keys`
(`local-stack/src/smoke.ts`). The console — `iam-ui` and `dashboard` — uses `/admin/rpc` exclusively.
Everything else (principals CRUD, grants, roles, policies, share-links, audit, auth-log, me, list
apps, rotate) is an uncalled mirror, and every one of them is a second place a gate can be forgotten
(SEC-11) or an error can leak (CORR-4).
_Acceptance:_ REST retains only the machine/provisioning endpoints a deploy step and bootstrap
actually call, documented as such; everything else is reachable over `/admin/rpc` only; the
"policy, audit and hidden-object behaviour must not diverge by transport" problem stops existing
because there is one transport for those operations.
_Touch points:_ `packages/iam/src/admin/**`, `packages/iam-contract/src/index.ts`,
`packages/control/src/iam-admin.ts` (the path-rewriting gateway), `docs/reference/core-application-composition.md`.

### Wave 4

**WU-H — Documentation sweep** · small · DOC-1, DOC-4…DOC-12, package CLAUDE.mds
**WU-I — Operator session revocation** · medium · closes **backlog 52** (deleted in `9d7396d`, ahead of
the work; its text is at `9d7396d^`)

**WU-J — Consolidate the enforcement ADRs** · medium
Where enforcement lives has been decided four times: ADR-0007 moved it to a proxy and retired an
invariant inside itself; 0008 chose Caddy; 0010 amends 0008 after implementation disproved its
central assumption; 0021 replaces the shared-cookie handoff 0007/0008 silently assumed. backlog 18
finishes the job by deleting the SDK's copy. A reader today has to replay four documents plus a
retired invariant to learn one answer.
_Acceptance:_ one ADR states the settled model end to end — the proxy is the only enforcement point,
Caddy is HTTP correctness only, gates are evaluated once in TypeScript, the session is handed over as
a one-time code, and the app only ever verifies an injected token. 0007/0008/0010/0021 are marked
`Superseded by NNNN` and kept as history (they hold the _why_, including the three verified Caddy
semantics mismatches, which must not be lost). `docs/reference/` is re-derived from the new ADR —
`overview.md`, `core-application-composition.md` and `cross-host-sso.md` all currently describe the
pre-consolidation world. Record the Cloudflare least-privilege asymmetry (ARCH-2) here rather than in
a separate ADR.
_Note:_ `docs/CLAUDE.md` says ADRs are immutable and superseded, never rewritten. This follows that
rule — it adds one and re-statuses four; it does not edit their bodies.

## Out of scope

- **The Zerops bring-up track** — backlog 41 (`putServiceEnv` signature change; it needs a `clientId`
  that `ZeropsApiOptions` does not carry, so it is a signature change and not a reordering), 47
  (private git source), 05 (production topology and Operations ingest end to end). It needs the live
  account; it is a separate sprint. The custom-domain question is answered — stay on `.zerops.app` —
  so it no longer blocks that sprint's start.
- **backlog 49** (per-client rate limits on public IAM) — needs a composition-specific trusted client
  coordinate, which is a design question this sprint does not settle.
- `packages/iam-ui`, `packages/dashboard` — excluded from the review by the user.

## Decisions taken (from the review canvas, 2026-08-04)

| Question                      | Answer                                                                                       |
| ----------------------------- | -------------------------------------------------------------------------------------------- |
| backlog 18                    | Ship it now; do not repair `session.ts`, delete it                                           |
| SEC-6 empty registry          | Narrow the opt-out: 400 when the registry is empty AND `safeRedirect` refuses the redirect   |
| SEC-12 empty origins array    | Reject — it is a caller error                                                                |
| SEC-2 existing credentials    | Hard cutover; `app IS NULL` stops working, keys are reissued                                 |
| SEC-7 self-bound key lifetime | `expiresAt` becomes required                                                                 |
| SEC-13 `pruneSessions`        | Wire into the cron, prune at expiry                                                          |
| SEC-21 `FABRIKA_IAM_KEY`      | Required; the proxy refuses to boot without it                                               |
| SEC-14 flight cookie          | Sign it; refuse an unverified flight                                                         |
| SEC-20 `__Host-`              | Prefix only; duplicate-aware cookie reading not needed                                       |
| CORR-4 batch surface          | Keep batching, scrub errors in the middleware independently of status                        |
| CORR-1 email backfill         | Fail loud — the migration stops and an operator resolves the collision                       |
| DOC-6 dead spec pointer       | Drop the pointers, fold the surviving sentence inline                                        |
| ARCH-2 Cloudflare split       | Write an amending ADR admitting it is a typing convention there; do not split the entrypoint |
| CORR-10 cross-app grants      | Validate against the UNION of every registered app's catalog; fix the seed                   |
| OIDC boot asymmetry           | Unify on fatal — refusing to boot beats booting misconfigured                                |
| Custom domain (Zerops)        | Stay on `.zerops.app`; ADR-0021 removed SSO's dependency on a shared cookie                  |

### ARCH-2 — the reasoning, so it is not re-derived

On Zerops the split is real: `IamRpc` is reached over `/rpc/*` with `FABRIKA_IAM_RPC_KEY`, the mint
surface over `/auth/mint/*` with `FABRIKA_IAM_PROXY_KEY`. A holder of the RPC key genuinely cannot
redeem. On Cloudflare `exchangeAuthCode` is a method on the `WorkerEntrypoint`, so every holder of
the `IAM` service binding can call it and no key is involved at all.

To profit from that an attacker needs a Worker holding the `IAM` binding — already a first-party,
already-trusted component — **and** a live, unconsumed code inside its two-minute window. What
actually stops replay is the code's own properties: single-use via a conditional `UPDATE`, hash-only
storage, and the `(session, app, return URL)` binding. So this is a defence-in-depth degradation,
not an exploitable hole, and splitting the entrypoint buys little for real churn.

The genuine defect is documentary: `docs/reference/cross-host-sso.md` reads as though the split holds
on both providers. Fix the doc, and record the asymmetry in an ADR that amends 0021.

### CORR-10 — the reasoning

Two sub-issues. `seed.dev.sql:74` is simply a bug: the seeded "super-admin" grant resolves to zero
permissions. Fix it.

The design half: `admin/handlers.ts:585-601` validates an inline grant's action patterns against the
app's action catalog, and a cross-app grant (`app = null`) has no single catalog, so every pattern
except `*` is refused as "unknown action pattern". That is an accident of implementation — nothing
documents it — and it inverts least privilege: an operator who wants to grant `deploy.read`
everywhere has to grant everything instead. Validate cross-app patterns against the **union** of
every registered app's catalog.

Note in the code what this check is and is not: `permits()` matches patterns at request time and
never pre-expands them, so an app registered later is covered by an existing grant. The union check
therefore catches typos; it is not a security boundary. Say so in the rejection message too, which
today is a bare "unknown action pattern: X".

## Still open

Nothing blocking. The Zerops bring-up track (backlog 41 / 47 / 05) is deferred to its own sprint —
see Out of scope.

## Run log

**Wave 1 — WU-B landed** (`df858e0`). 16 findings. Two things the review missed, both verified against
a running caddy 2.10.2 rather than assumed:

- The pre-existing `response>headers>Set-Cookie` log filter was a **dead key** — Caddy puts response
  headers in a top-level `resp_headers` object. It was harmless only because `should_log_credentials`
  already masks `Set-Cookie`; it does not mask `Location`, which is where both the handoff code and the
  login bounce ride.
- Redacting `Location` with the same pattern does not cover the hazard SEC-5 itself describes: the login
  bounce percent-encodes the whole original URL into `?redirect=`, so a declared query credential
  reappears as `%3Fpxt%3D…`, which `[?&]pxt=` cannot match. Hence an unconditional `?redirect=`
  alternative. Side effect: an app's own `?redirect=` is redacted from access logs.

⚠ **Availability change to watch**: SEC-15 makes `unavailable` on the human path a terminal 503 rather
than a fall-through. Gates ordered `[human /*, public /*]` with a stale `px_token` and JWKS down now
yield 503 where they used to fall through to the public rule and serve. Fail-closed and correct per the
finding, but it is a behaviour change.

**Wave 1 — WU-A landed** (`38bcc6c`), closing backlog 18. Net −590 lines. Two consequences the plan did
not anticipate:

- `readCredentials` had to start reading the proxy token header first. Behind the proxy the browser holds
  only `px_session`, so `iam.listPrincipals(request)` (Operations' assignee picker) would have forwarded
  no credential at all.
- **Nothing writes the `px_token` cookie any more.** The proxy only ever writes `px_session` and treats
  `px_token` as client-supplied. `tests/browser/operations-issue-triage.test.ts:44-56` polls for that
  cookie to learn the browser's principal and will hang. WU-D owns the fix.
- **Browser runs are red until WU-D lands** — the mirror image of fact 3. `compose.browser.yaml` sets
  `DEV: ""`, so control and operations take the real path, and the local manifest injects no token
  because `vozka` is `public`. The local console is now closed rather than open, which is the safer
  failure, but it is still WU-D that unblocks it.

**Wave 1 — WU-C1 landed** (`8216811`), +1065/−149, with the Postgres suites actually executed against a
real instance (1739 pass repo-wide, 0 fail). CORR-1 was fixed at the choke point rather than its four
call sites: `PrincipalRepository` is now the only place that normalizes, `email` holds the mailbox and
`label` the display spelling, and every write path puts the `principal_email_claims` reservation in the
same batch so it moves with an address instead of going stale. That also removed `LOWER()` from the
queries, which is what made the two engines disagree about non-ASCII mailboxes in the first place.

⚠ **Repo-wide fact, learned the hard way**: Bun's `Database.exec()` throws on a compile error but
**swallows a constraint violation and keeps running the rest of the script**. A migration guard verified
through `exec` looks like it passed. `wrangler d1 migrations apply` splits statements and stops, so
production is unaffected — but any test that applies a SQLite migration file must do it one statement at
a time. Documented in `packages/iam/CLAUDE.md` and in `migration-guards.test.ts`.

**Consequence to hand to WU-L**: with an empty `origins` array rejected by the admin API (SEC-12) and an
empty registry now a 400 for an unreachable redirect (SEC-6), **an operator can no longer un-register an
app through the API** — only by deleting rows. The opt-out still works for a genuine shared-cookie
installation, so this is an operational gap rather than a break, but clearing a registry should be an
explicit operation rather than an overloaded empty array. Fold it into WU-L's admin surface work.

`lookupActionUser`'s `ambiguous` status is now unreachable through the application — the schema forbids
two rows per mailbox. It was kept as a fail-closed belt, and the recovery buckets are unchanged, so the
indistinguishability constraint still holds.

**Wave 2 — WU-D landed** (`399cd3b`). The local stack now runs the production topology in
miniature: proxy matches a `human` gate → 302 to IAM → `LOCAL_DEV_LOGIN` → back to the original
URL. `DEV` is `""` for control and operations in both compose files, so no synthetic persona
exists anywhere — which is the precondition WU-K needed.

Sign-in locally uses the **shared cookie**, not the ADR-0021 handoff, and the reason is worth
keeping: `apps.setReturnOrigins` 404s for an unknown app and `vozka` is not registered in IAM,
because only a deploy reconciles fabrika's own schema. Forcing the handoff locally would have
meant inventing a local-only app registration — adding a local-only mechanism in order to remove
one. Local handoff coverage waits for that registration (WU-G).

The gates are copies, because `fabrika.config.ts` imports the Cloudflare provider and will not
compile inside local-stack's strict program. A test builds the real Workers, decodes the manifest
they bake in and asserts equality, so they cannot drift silently. The cheaper fix is to export
both gate sets from a module free of `@fabrika/provider-cloudflare` — worth doing when something
else touches those files.

Two stack flakes fixed on the way, both found by running it rather than reading it: a base64url
secret beginning with `-` made `mc alias set` read it as a flag, so `minio-init` looped and the
whole stack came up without object storage (about one reset in sixteen); and `pg_isready -U postgres`
answers over the unix socket **during initdb**, so IAM migrated against a server that was about to
shut down.

Found by running it, not by reviewing it — handed to WU-C2:

- ⚠ **The console's Access plane 403s, in production too.** `control/src/node/iam-admin.ts:19-23`
  rewrites the browser's `Origin` to the **private** RPC URL's origin; `iam/src/admin/router.ts:119`
  compares against the **public** issuer. They never agree in the normal deployment shape, and the
  bearer exemption needs `session === null`, which a console POST never satisfies. Introduced by
  `e1152bb`, before this sprint. The rewrite was papering over a deeper mismatch — even unrewritten,
  the browser's origin is the _console's_, never IAM's.
- **Control's machine escape hatch is dead behind the proxy.** `FABRIKA_IAM_PROVISIONING_KEY` has no
  `credentials` row, so `mintFromKey` answers `invalid_key` and the proxy refuses the request before
  control sees the bearer. The local stack now provisions a real IAM service key instead — which is
  the shape the answer should take.

Filed rather than fixed here: [backlog 53](../backlog/53-reauthor-the-operations-console-scenarios.md)
(three browser scenarios encode a console that changed in `83581a9`; they have been red since and
the failure reads as an auth regression) and
[backlog 54](../backlog/54-give-operations-its-own-proxy-app-identity.md) (the two compositions
disagree about Operations' app id, so its gate rules would not work if they mattered).

Promoted to **WU-M**: a `human` gate miss is a 302 even for an XHR, so an expired console session
turns an RPC POST into a redirect `fetch` cannot follow.

**Wave 3 landed.** WU-M (`0c9c3f7`) and WU-K (`2c040fe`, net −1013), plus `8bfa6b5` removing the IAM
gateway's dead local bearer that WU-K found and could not touch.

WU-M chose `Sec-Fetch-Mode` over `Accept` for the navigation signal, and the argument is the reusable
part: `Sec-` is a forbidden header **prefix**, so `fetch` and XHR cannot set it — the browser writes it,
so it _describes_ the caller. `Accept: text/html` is an ordinary header any XHR may send and any
navigation may omit, so reading it would let the caller choose which answer shape it gets. Two Caddy
facts were measured against `caddy:2.10.2` rather than assumed and are now written down: the
`forward_auth` subrequest really does carry `Sec-Fetch-Mode`, and **a non-2xx auth response reaches the
client with its body and `Content-Type` intact** — the whole 401-JSON path depends on the second and it
was documented nowhere.

WU-K confirmed `FakeIamClient` had zero consumers outside the deleted branch and its own test; tests
moved onto real ES256 tokens. `control/wrangler.jsonc` was regenerated and its `migrations` array is
byte-identical — the part that must never shift. Browser suite: **9 pass / 1 fail**, against the five
red the plan expected; the console-403 fix took four of them with it.

⚠ **An honest gap WU-K recorded rather than papered over**: a non-admin role cannot be exercised
locally, because fabrika's own `AppSchema` reaches IAM only through a deploy, so IAM knows `notes` and
nothing else. WU-G has since made registering the console locally one ordinary call.

**Wave 4 — WU-G landed** (`9d7396d`), closing backlog 51. It projects the **app-wide** origin set rather
than the deploying environment's alone: `setReturnOrigins` replaces, and IAM's registry is keyed by app
id while `public_origin` is per environment, so sending one environment's origin would un-register the
others and a `stage` deploy would silently break `prod`'s sign-in.

Bookkeeping wrinkle: that commit also carries the deletion of `backlog/52`, which belongs to WU-I. Its
content is in git history at `9d7396d^`. WU-I has since landed, so the deletion is correct in the end,
just early.

## ⚠ WU-E is blocked on a decision — `__Host-` and shared-cookie mode are incompatible

`__Host-` **forbids the `Domain` attribute**. `SESSION_COOKIE_DOMAIN` exists to set one. So SEC-20 as
decided ("prefix only") cannot be applied to `px_session` in any installation that uses the shared-cookie
path — including the local stack, which WU-D deliberately put on it.

That surfaces a question this sprint's own goal implies. There are **two session-delivery mechanisms**:
the ADR-0021 handoff, and the shared cookie ADR-0021 kept as an optimisation ("it costs nothing, keeps
the local stack working unchanged"). "Costs nothing" is no longer quite true — it costs the `__Host-`
prefix, it is a second path through `readHandoff`, and it is why SEC-6 needed a narrowed opt-out at all.

And the reason to keep it just weakened: WU-G made registering an app's return origins one ordinary
call, so the local stack could run the handoff too. One session-delivery mechanism, `__Host-` on both
cookies, `SESSION_COOKIE_DOMAIN` deleted.

Against: it contradicts an explicitly-reasoned choice in an accepted ADR, and the shared cookie is
genuinely the cheaper path when an app really does share a domain with IAM — it saves a redirect.

**Decision needed.** Retire the shared cookie and take `__Host-` on both, or keep it and apply `__Host-`
only to the per-app `px_token` (which is already host-only).

**Considered and rejected — one shared `TokenVerifier`.** `packages/auth/src/verify.ts` is a near-twin of
`packages/proxy/src/verifier.ts`. They cannot share code cheaply: `@fabrika/auth-core` is deliberately
dependency-free and jose-free ("Signing/verifying stays in the packages that own it"), and the proxy must
not depend on the app SDK. A package existing to share ~90 lines between two consumers with genuinely
different cache lifetimes would be the over-engineering this sprint is removing. What must not drift is
their **three-state semantics**, so pin that with a shared conformance test instead — folded into WU-F.

**Wave 2 — WU-C2 landed.** 27 findings plus the OIDC boot asymmetry. Typecheck clean; `bun test` 1800
pass / 0 fail with the Postgres suites actually executed against a throwaway `postgres:17`, and the
console's Access plane verified against a running `local:up`.

⚠ **The priority item was not the finding as written — it was worse and it also hit Operations.** The
review said control's process-side gateway rewrote `Origin` to IAM's private RPC address while IAM
compared against its public issuer. Both halves are gone: the rewrite is deleted and IAM now holds a
REGISTRY of browser origins allowed to drive `/admin/*` (`FABRIKA_IAM_ADMIN_ORIGINS`, empty =
fail-closed, bearer-only callers exempt). But the same class of bug sat unfixed in
`operations-gateway.ts`, which compared `Origin` against `new URL(request.url).origin` — plain HTTP
behind a TLS-terminating balancer, so every operator write through the console was 403 in production
too. It now takes `publicOrigin` like the IAM gateway does. Backlog 50 fixed one of the two gateways.

**What stops the confused deputy after the change**: control's own same-origin check in
`forwardIamAdmin` / `forwardOperationsApi`, against `controlPublicOrigin(env)`. Verified live: a POST
to `/iam/admin/rpc` with `Origin: https://evil.example.com` and a real `px_session` is refused by
control with its own flat envelope, and IAM is never called. IAM's registry is the second, independent
lock — it refuses an unregistered origin with its own RPC envelope, which is how the two are told
apart in the test.

**Item 2 — the machine hatch is deleted, not repaired.** `FABRIKA_IAM_PROVISIONING_KEY` could not
pass a `service` gate and never will: it has no `credentials` row, so `mintFromKey` answers
`invalid_key` at the proxy. Machine access to the control plane is an IAM-issued service key
(`docs/reference/human-authentication.md` § First machine caller). IAM's own bootstrap use of the
provisioning key over `/admin/*` is untouched.

**Deviations from the decided plan, both deliberate:**

- **SEC-2 binds every credential to an app, but `app IS NULL` stays legal for a PRINCIPAL-BOUND one.**
  The decision said `app IS NULL` stops working. Taken literally it breaks the cross-app operator key
  the local stack (and `provisionApiKey`'s "all apps" option) deliberately issues, and it buys nothing:
  a bound credential carries no frozen authority — its permissions resolve per app through `grants`,
  which are already app-filtered. The hard cutover applies exactly where the defect was, to ANONYMOUS
  credentials, whose inline grants are frozen at issue and were delegation-checked against one app.
  Pre-existing share links have no app and are dead until reissued; the Postgres migration NOTICEs
  which ones.
- **Share links now require an explicit `app`, which changed `IssueShareLinkRequest`.** There was no
  other honest binding available: `createShareLinkUseCase` issued with `c.app` = `propustka`, i.e. IAM
  itself, so binding to that would have made every share link useless. The delegation check moved with
  it — an admin's permissions are now resolved AT THE TARGET APP, so an app-scoped admin delegates only
  what they hold there. `iam-ui`'s issue form grew an app selector.

**OIDC unified on fatal, and that made the local Cloudflare config password-only.** `buildOidc` now
requires issuer/client id/secret whenever the method is enabled, matching the Bun path. `wrangler dev`
has none of those, so `fabrika.config.ts`'s local vars flipped to `OIDC_ENABLED: 'false'` /
`PASSWORD_ENABLED: 'true'` — which is what the docker stack already ran.

**CORR-4 keys the mask on the ERROR TYPE and keeps the status mask.** Scrubbing only by `type:
'internal'` would have un-masked the deliberate `fail(502, …)` on email delivery, which wave 1 wrote
to be opaque. So: 5xx is replaced outright as before, AND every `type: 'internal'` envelope is scrubbed
whatever the status — which is the half that was missing, because a batch always answers 200.

**Two things the plan did not anticipate:**

- **`packages/local-stack/__tests__/` is where a cross-package test belongs.** The gateway-to-IAM test
  the acceptance asked for cannot live in either package — neither depends on the other, and it must
  not. `proxy-gates.test.ts` had already established the pattern: outside `src/`, so `typecheck` never
  follows the import. `console-access-plane.test.ts` composes control's real gateway over a real socket
  in front of IAM's real app, with console origin ≠ issuer ≠ private address. Re-adding the header
  rewrite fails exactly two of its cases.
- **D1's 100-bound-parameter limit made CORR-9 a correctness bug, not tidiness.** The old prune spent
  one parameter per KEPT value, so an app with a hundred actions could not reconcile at all. Fixed by
  clearing then writing inside the same batch, which also made every statement's width constant.

**Not done, and why:** SEC-22's cursor is wired through the RPC contract and the REST endpoints, but
`iam-ui` and `dashboard` still render only the first page — they were excluded from the review and no
"load more" control exists. Paging is available to them the moment someone adds one.

**Wave 4 — WU-L and WU-I landed together** (`950fd19`), then **WU-F** (`a94078e`). `/admin/*` REST is
down to the four provisioning operations a deploy step and the first-machine bootstrap actually call;
about two dozen uncalled mirrors are gone, and `DELETE /admin/principals/:id` — the one with no RPC
counterpart — became `principals.delete` rather than being lost. `sessions.list` / `revoke` /
`revokeAll` close backlog 52. A consequence worth knowing: bearer-only is the sole exemption from the
`FABRIKA_IAM_ADMIN_ORIGINS` check, so `reconcileSchema`'s admin key is now effectively required.

**Wave 4 — WU-J and WU-H landed.** One ADR now states the enforcement model end to end —
[ADR-0022](../decisions/0022-the-proxy-is-the-only-enforcement-point.md) — and 0007/0008/0010/0021 are
`superseded by 0022`, kept and unedited. It records the two things none of them did: the Cloudflare
least-privilege asymmetry (ARCH-2) and the honest cost of keeping two session-delivery mechanisms,
which it deliberately leaves open for WU-E.

`docs/reference/` was re-derived against the code rather than against the ADRs. Six claims were false,
not merely stale — the SDK still enforcing "as defence in depth", the proxy described as reaching IAM
over the `IamRpc` / `/rpc/*` transport, "`@fabrika/auth` middleware" that no longer exists, the OIDC
admission allowlist described as required configuration, IAM's platform-specific files listed as
`env.ts`/`index.ts`/`db.ts`, and the handoff's registry check stated as two outcomes when the code has
three. `overview.md` additionally still called the proxy "not new code" and never mentioned cross-host
SSO, and `INDEX.md` said no sprint was active. `packages/auth-core` gained the CLAUDE.md it never had.

**Still open, and why this sprint is not closed:** WU-E is blocked on the `__Host-` versus shared-cookie
decision above, and the browser suite has one known failure
([53](../backlog/53-reauthor-the-operations-console-scenarios.md)).
