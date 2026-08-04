# Sprint — Auth hardening: make the proxy the only front door

**Theme.** A comprehensive review of `iam` / `proxy` / `auth` / `auth-core` produced 63 findings. The
single decision that shapes the rest is [backlog 18](../backlog/18-shrink-the-app-sdk.md): the app
SDK still carries a complete second enforcement path, and 15 findings live in code that is supposed
to be deleted. So the sprint's goal is the one ADR-0007 stated and never finished — **the proxy is
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
**WU-G — Project return origins from the control plane** · medium · closes [backlog 51](../backlog/51-project-return-origins-from-the-control-plane.md)

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
**WU-I — Operator session revocation** · medium · closes [backlog 52](../backlog/52-revoke-sessions-an-operator-no-longer-trusts.md)

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
