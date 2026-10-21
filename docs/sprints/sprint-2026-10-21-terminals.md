# Sprint — terminals: a person signs in on a shared computer (2026-10-21)

**Goal.** Ship [ADR-0067](../decisions/0067-a-terminal-signs-a-person-in-on-an-application-s-word.md): an enrolled
terminal, application-asserted identification through the unchanged handoff, ceiling-bounded terminal sessions,
and a proxy sign-out.

**Theme.** Every unit serves one end-to-end path: an administrator enrols a browser. A person on it identifies
with whatever the application asks for, works with their own identity, permissions under the ceiling plus the
terminal's grants, and signs out for the next person. The sprint succeeds when an in-process test drives that
path through IAM and the proxy, and the existing handoff tests still pass unchanged.

## Refs re-verified at HEAD (2026-10-21, `6e279393`)

- ✔ `/auth/login` GET continues a handoff from a current login, or renders sign-in. The terminal branch slots
  in after the current-login check — `packages/iam/src/auth/login.ts:34-58`.
- ✔ A login is a root `sessions` row. Its cookie is set in `issueSession`, and `handoffLocation` issues the code
  against its id — `packages/iam/src/auth/sessions.ts:62-117`, `packages/iam/src/auth/handoff.ts:118-130`.
- ✔ Redemption copies principal, `authentication_method` and `expires_at` from the parent —
  `packages/iam/src/handoff.ts:112-151`. Terminal fields must be copied the same way.
- ✔ Validity joins one parent level only — `packages/iam/src/repositories/sessions.ts:98-121`. The terminal join
  goes into the same statement.
- ✔ `mintToken` resolves the session principal only; the key downscope filter is `inline.filter(e => permits(...))` —
  `packages/iam/src/tokens.ts:48-102`, `:279-282`.
- ✔ The proxy reads a session only for `human` callers and requires `ptype === 'user'` —
  `packages/proxy-core/src/authorize.ts:388`, `:508-535`. The terminal session is a user session, so neither
  changes.
- ✔ The token cache is keyed per credential (`cacheKey(app, kind, value)`) — `packages/proxy-core/src/authorize.ts:457`.
  Sign-out deletes the session's entry.
- ✔ The latest migration is `0020_public_workloads.sql` in both dialects, so the next is `0021`.
- ✔ Public procedures run as their own workload (ADR-0063). App → IAM calls use the transport key of ADR-0064.
- ⚠ No app-host sign-out exists. Applications link to IAM `/auth/logout` (`packages/dashboard/src/lib/session.ts:37`),
  and a cached token outlives that for up to 300 s.

## Work units

### WU1 — Persistence (M)

- **Problem.** The schema has no terminals, identifications or terminal-bound sessions.
- **Verify first.** Read `0001_init.sql` for `sessions` and `auth_log` in both dialects. Check how
  `0020_public_workloads.sql` added a side table to a `service` principal. Check how a SQLite CHECK change was
  done before: a table rebuild, or a new constraint style.
- **Scope.**
  - `0023_terminals.sql` in both dialects:
    - `terminals` (principal_id PK → principals, label, enrolled_by, token_hash UNIQUE, profile JSON: asserters,
      ceiling per app, session_ttl; created_at, last_seen_at, revoked_at);
    - `terminal_identifications` (id_hash PK, terminal_id, app, return_url, handoff_state, handoff_challenge,
      created_at, expires_at, consumed_at);
    - `sessions.terminal_id`, `sessions.asserted_by`, `terminal_assertion` in the method CHECK, and a CHECK that
      a `terminal_assertion` session has both;
    - `auth_log.terminal_id`, `auth_log.asserted_by`.
  - A `TerminalRepository`: enrol, get by token hash, get by id, list, update profile, revoke, which also
    revokes its sessions in one batch.
  - Identification create, consume (a conditional UPDATE), and cancel.
  - Session validity joins `terminals` for rows that carry `terminal_id`.
- **Acceptance / witness.**
  - Repository tests on SQLite, plus Postgres when `FABRIKA_TEST_POSTGRES_URL` is set.
  - A revoked terminal makes `getActiveSessionByHash` return null for its sessions and their children.
  - A consumed identification cannot be consumed again.
- **Touch points.** `packages/iam/migrations*/0023_terminals.sql`, `packages/iam/src/repositories/{terminals,sessions,audit}.ts`,
  `packages/iam/src/db.ts`.

### WU2 — Mint and session semantics (M)

- **Problem.** A terminal session must mint `(person ∩ ceiling) ∪ terminal`, only for its asserting application.
- **Verify first.** `resolvePermissionsAt` for a `service` principal with grants; `permits` with wildcard patterns.
- **Scope.**
  - `sessionUsable` case `terminal_assertion`.
  - `exchangeAuthCode` copies `terminal_id` and `asserted_by` to the child.
  - `mintToken` for terminal sessions:
    - refuse an audience other than `asserted_by`;
    - compute the ceiling filter, then add the terminal principal's permissions with source `terminal`;
    - add the claims `amr` and `terminal`.
  - IAM's administration audience refuses terminal sessions.
  - `auth_log` rows carry `terminal_id` and `asserted_by`.
- **Acceptance / witness.** Unit tests:
  - An empty ceiling yields only terminal grants.
  - A ceiling keeps only matching person entries.
  - A wrong audience is refused.
  - A revoked terminal is refused.
  - A personal session is unchanged (an existing test, untouched).
- **Touch points.** `packages/iam/src/{tokens,handoff,auth,resolve}.ts`, `packages/auth-core/src/{token,types}.ts`
  (`PermissionSource` gains `terminal`).

### WU3 — Enrolment and administration (M)

- **Problem.** No way to make a browser a terminal or to manage one.
- **Verify first.** How the IAM vocabulary declares actions (`iamAdministrationScope`). How server-rendered pages
  are built (`password-pages.ts`) and how their CSRF and same-origin checks work.
- **Scope.**
  - IAM action `terminals.manage`.
  - `/auth/terminals/enroll`:
    - GET: a form, which requires a current login holding `terminals.manage`;
    - POST: same-origin; creates the service principal and terminal, sets `__Host-px_terminal`, revokes the
      login and clears its cookie, writes an audit event, renders "enrolled".
  - `/admin` API: list terminals, set the profile, revoke.
  - Catalog strings in en and cs.
- **Acceptance / witness.** Route tests:
  - enrol without permission → 403;
  - enrol → cookie set, login revoked;
  - revoke → the terminal's sessions are invalid.
- **Touch points.** `packages/iam/src/auth/{routes,terminals}.ts`, `packages/iam/src/admin/*`, `packages/iam/src/catalog/*`,
  `packages/iam-contract`.

### WU4 — Framework: declaration, claims, SDK (M)

- **Problem.** An application cannot declare an identification page, read the terminal from its principal, or
  call the identification RPCs.
- **Verify first.** How the contract and app schema reach IAM (`app-schema.ts` reconciliation), and how a
  public procedure's handler reaches IAM over the ADR-0064 transport.
- **Scope.**
  - Contract: `terminal: { identify: '/path' }`, validated as a same-origin absolute path and carried in the app
    schema IAM stores.
  - Token parser accepts optional `amr` and `terminal`. `ctx.principal.terminal`.
  - SDK `ctx.iam.terminals.inspect(id)`, `.assert(id, principalId)`, `.cancel(id)`, available to a public
    procedure.
  - The ADR-0062 compatibility rule: an application that declares `terminal` needs a proxy that serves sign-out.
- **Acceptance / witness.**
  - Contract tests (valid and invalid paths).
  - Token parse tests: with and without claims; an older parser ignores them.
  - An SDK test against a fake IAM transport.
- **Touch points.** `packages/auth-core/src/{contract,token}.ts`, `packages/app/src/implement/*`, `packages/auth/src/*`,
  `packages/iam/src/repositories/app-schema.ts`.

### WU5 — Identification flow in IAM (L)

- **Problem.** IAM never sends a browser to an application to identify a person.
- **Verify first.** WU1, WU2 and WU4 merged. Re-read `handleLogin`.
- **Scope.**
  - `handleLogin` branch: no current login, a valid terminal cookie, the app among the asserters and declaring
    `identify` → create an identification, then 302 to `identify` on the handoff's return origin with
    `?identification=<id>`.
  - RPCs over the app transport:
    - `inspectIdentification`;
    - `assertIdentity`, which takes the app from the transport, consumes, checks, creates the root login
      (method, terminal_id, asserted_by, TTL; no cookie), issues the code with `handoffLocation`, and returns the
      callback URL;
    - `cancelIdentification`.
  - `/auth/terminals/release`: validate the redirect against the app's return origins, revoke the terminal's
    active sessions, 302.
  - `last_seen_at` update.
- **Acceptance / witness.**
  - Route tests: terminal + asserter → redirect with an identification; non-asserter → normal sign-in; personal
    login present → continues as that person.
  - RPC tests: wrong app, expired, consumed, external principal, revoked terminal → refused.
  - Happy path → a code that `exchangeAuthCode` redeems into a child with `terminal_id`.
- **Touch points.** `packages/iam/src/auth/{login,terminals}.ts`, `packages/iam/src/rpc*.ts`, `packages/iam-contract`.

### WU6 — Proxy sign-out (S)

- **Problem.** A cached token keeps the previous person signed in for up to 300 s.
- **Verify first.** How the proxy answers `/__fabrika/auth/callback` before endpoint selection, and the cache API.
- **Scope.** `GET /__fabrika/auth/signout?redirect=` (only when `Sec-Fetch-Site: same-origin`): clear the session
  cookie, delete the cache entry, 302 to IAM `/auth/terminals/release`. Update ADR-0022 §4's invariant wording.
- **Acceptance / witness.** Proxy tests:
  - cross-site → 403;
  - same-origin → cookie cleared, cache entry gone, redirect to the release URL;
  - the next request bounces to sign-in.
- **Touch points.** `packages/proxy-core/src/{authorize,service}.ts`, `packages/proxy` (Caddy route, if it
  matches paths).

### WU7 — End-to-end witness and reference docs (M)

- **Scope.**
  - An in-process test that wires IAM, proxy and a fake application: enrol → bounce → identification →
    assert → callback → token with `terminal` → sign-out → next bounce opens a new identification.
  - `docs/reference/human-authentication.md` gains a "Terminals" section.
  - The `docs/decisions/README.md` index row; `cross-host-sso.md` mentions the sign-out path.
- **Acceptance / witness.** The test passes. `bun run check:ci` is green.

## Out of scope (explicit)

- A console UI for terminals. The `/admin` API is enough for the first application; the dashboard follows as a
  backlog item.
- An example application with a PIN pad. The end-to-end test uses a fake application.
- Phone-based presence (QR codes). That would be a different mechanism; there is no backlog item yet.

## Decisions

- The name is "terminal", not "device", because ADR-0042 owns "device" (`device_authorizations`).
- The terminal principal is `service` plus a side table, not a new principal type (no `principals` rebuild).
- The identification is redirect-based and IAM-driven, so the ADR-0023 handoff stays unchanged.
- The ceiling is mandatory, empty by default.

## Sequencing

| Step | Units                                                                                                               |
| ---- | ------------------------------------------------------------------------------------------------------------------- |
| 1    | WU1                                                                                                                 |
| 2    | WU2, WU3, WU4, WU6 in parallel (disjoint packages; WU2 and WU3 both touch IAM — run them sequentially if one agent) |
| 3    | WU5                                                                                                                 |
| 4    | WU7                                                                                                                 |

## Run log

- WU1: the profile is `terminals.session_ttl` (CHECK 1–3600) plus one `terminal_asserters (terminal_id, app, ceiling)`
  row per asserting application, not one JSON column. A ceiling exists only for an asserter, so no state can name one
  for another app. The ceiling is a JSON array of action patterns, app-wide.
- WU1: the SQLite `sessions` rebuild also rebuilds `auth_codes`, `oauth_grants`, `oauth_codes` and
  `oauth_refresh_tokens`, kept aside and restored, as control's `0005_approved_access.sql` does for a referenced table.
- WU1: `sessionUsable` got its `terminal_assertion` case (`true`; the validity join checks the terminal), because the
  exhaustive switch does not compile without it. `SessionDto.authenticationMethod` in `iam-contract` gained the value.
- WU1: enrolment is `terminals.enrolStatement`, composed with `principals.createServiceStatement` (WU3 adds the login
  revocation and the audit row to the same batch). Cancelling an identification sets `consumed_at`, scoped to its app.
- WU1 → WU2: the row CHECK requires `terminal_id` and `asserted_by` on every `terminal_assertion` session, so
  `exchangeAuthCode` fails for a terminal parent until it copies both to the child.
- WU1 → WU3/WU5: a terminal principal is a `service` row, so check that `apiKeys.list` does not show it. Nothing calls
  `terminals.pruneIdentifications` yet; the maintenance cron should.
- WU2: the ceiling is a set of global patterns. WU5 replaced the `permits` filter with `narrowPermissions` (moved out of
  `oauth.ts`): a person's `*` or `x.*` now yields the narrower ceiling actions, keeping its scope (→ ADR-0067 §4).
- WU2: `mintToken` also refuses a terminal session for a platform audience, even as its asserter, and when the terminal
  principal is disabled or the profile no longer lists the asserter. `exchangeAuthCode` refuses (`wrong_app`) a code
  issued for an app other than the login's `asserted_by`.
- WU2 → WU4/WU5: a `perms` entry with source `terminal` makes an older `parseAccessClaims` refuse the whole token
  (`parseSource` is closed). Only an application whose framework knows terminals may be an asserter; WU5's "declares an
  identification page" check is what enforces that.
- WU3: the action is `iam.terminals.manage`, in IAM's `iam.*` namespace like `iam.admin` and `iam.users.manage`. It gates
  enrolment only; `terminals.list`/`setProfile`/`revoke` of `/admin/rpc` require `iam.admin`, like the grants a terminal's
  principal holds. "The `/admin` API" is these `/admin/rpc` procedures: `/admin/*` REST stays closed.
- WU3: `setProfile` also sets the label (on the terminal's principal too, which audit rows name). An asserter must be a
  registered app that is not a platform audience; ceiling patterns pass `isActionAllowed` against its catalog as a typo
  check and may be wildcards even for a contract application, because a ceiling narrows and grants nothing.
- WU3: `__Host-px_terminal` has `Max-Age` 400 days, the browser's cap; revocation, not expiry, ends a terminal. Enrolling
  a browser that already holds a terminal cookie leaves the old terminal enrolled; an administrator revokes it.
- WU3 → WU5: the enrolment's audit and `logout` rows are unconditional in the batch, from the login read just before;
  WU5 may refresh the terminal cookie's `Max-Age` on each identification. `TERMINAL_COOKIE` lives in
  `packages/iam/src/auth/terminals.ts`.
- WU6: absent `Sec-Fetch-Site` is refused (403 `cross_site`), as for a session non-`GET`; the proxy is lenient on
  absence only for the answer shape (`Sec-Fetch-Mode`), which admits nothing. A non-`GET` is 403 `no_endpoint`.
- WU6: `redirect` is required; absent, relative, `//`, `\`, whitespace or another origin is 400 `bad_redirect`.
- WU6: `AUTH_SIGNOUT_PATH` and the release path live in `proxy-core/src/constants.ts`, not `auth-core`; IAM's
  `/auth/terminals/release` route (WU5) must match `SIGNOUT_RELEASE_PATH`, which the WU7 end-to-end test witnesses.
- WU6: no Caddy change; the generated chain forwards every path to `forward_auth`, as for the callback.
- WU6 → WU4: no manifest capability flag. The Cloudflare proxy Worker deploys at the platform's release with each
  application, and every older reader a Zerops namespace proxy may be pinned to predates sign-out. So the rule is:
  an application that declares `terminal` is refused behind a namespace proxy pinned to another source than this
  control plane's (`assertNamespaceProxyReads`), keyed on the contract, not on a proxy row.
- WU4: the declaration is the vocabulary's `terminal: { identify: '/path' }` (beside `members` and `directory`), not a
  contract section; `buildArtifact` also refuses a path that no `public` SPA mount serves, since a credentialed one would
  bounce the terminal back to sign-in. IAM stores it in `app_terminals` (migration `0024_app_terminals.sql`, both
  dialects); `appSchema.getTerminalIdentifyPath(app)` answers it or null.
- WU4: the SDK is `ctx.terminals.inspect / assert / cancel`, not `ctx.iam.terminals`: it sits beside `ctx.members` and
  `ctx.links`. It exists on an RPC procedure and a public procedure of a vocabulary that declares a terminal, and is an
  `Unavailable` elsewhere. `inspect` answers null and `assert` `{ ok: false, reason }` for `not_found` and
  `invalid_principal`; a transport failure is a 503, and IAM refusing the application's own credential is the server
  fault `terminal_refused`.
- WU4: the transport is the membership transport (`FABRIKA_IAM_RPC_URL` + `FABRIKA_IAM_RPC_KEY`, `/membership/<method>`)
  and the IAM binding on Cloudflare, not an ADR-0064 receiver: ADR-0064 names membership as the existing app → IAM
  channel, and its key already pins `<app>@<env>`. Control issues the key for a contract that declares a terminal, and
  IAM's reconcile keeps it while `app_terminals` has a row. `boot` refuses a terminal contract without the transport; the
  test kit's default answers every identification `not_found` (`TestKitOptions.terminals` replaces it).
- WU4: the WU6 compatibility rule is `entriesNeedingCurrentProxy` naming `terminal` for a contract that declares one;
  the approval diff shows the declaration as a widening for closer review. An older framework cannot compile the field,
  so the WU2 parser rule needs no check of its own.
- WU4: `ctx.terminals` is tested through an RPC procedure (the caller's token as the credential); the public procedure
  path (its workload token) shares the helper, but its runtime needs Postgres, so no test drives it yet (WU7).
- WU4 → WU5: implement `IamTerminalRpc` (`packages/auth-core/src/terminal.ts`) in IAM:
  - `inspectIdentification({ app, credential, requestId, id }) → { ok: true, terminal: { id, label }, expiresAt } | failure`;
  - `assertIdentity({ app, credential, requestId, id, principalId }) → { ok: true, callbackUrl } | failure`;
  - `cancelIdentification({ app, credential, requestId, id }) → { ok: true } | failure`;
  - failure is `{ ok: false, reason }` with `missing_token | invalid_token | not_allowed | not_found | invalid_principal`
    (`TerminalFailure`); an unknown, expired, consumed, cancelled or other-app id, a revoked terminal and a dropped
    asserter are all `not_found`. `credential` is the caller's verified token (a public procedure's workload token);
    require its `aud` to be `app`.
  - Register them on the membership transport (`OPERATIONS` in `packages/iam/src/membership-http.ts`, pinned to the
    key's app like the others; parse inputs strictly in `rpc-inputs.ts`), and on `PropustkaApplication` in
    `packages/iam/src/index.ts`, where the app is the credential's `aud` (the binding carries no other identity). The
    client sides are `HttpIamTerminals` and `DecodedIamTerminals` in `packages/auth/src/rpc-http.ts`, and
    `bindingTerminals` in `packages/app/src/cloudflare.ts`, which detects the three methods on the binding.
  - Redirect to `<return origin><identify>?identification=<id>` (`IDENTIFICATION_QUERY_PARAMETER`), and refuse the
    terminal branch when `getTerminalIdentifyPath(app)` is null.
- WU5: `assertIdentity` checks the principal before it consumes the identification, so `invalid_principal` leaves it open
  for another try; a dead id is consumed by nothing. The terminal principal being disabled is `not_found` too.
- WU5: the identification operations accept only a verified access token whose `aud` is the named app (any `ptype`), not a
  `px_` key. They are on the membership transport and `PropustkaApplication`, not on the platform `/rpc/*`.
- WU5: `auth_log` rows: `terminal_identification` (allow, no principal) in the identification's batch,
  `terminal_assertion` (allow) in the login's batch, `terminal_assertion_<reason>` (deny) in `waitUntil`, and one
  `terminal_release` `logout` per login a release ends. Every one carries `terminal_id`/`asserted_by`; `app` is IAM's.
- WU5: opening an identification refreshes `__Host-px_terminal`'s `Max-Age` and sets `last_seen_at` in the same batch
  (`markSeen` is gone). The release is a `GET` with no same-origin check (IAM `CLAUDE.md` records the exception).
- WU5: `TERMINAL_RELEASE_PATH` lives in `iam/src/auth/terminals.ts`; IAM's test pins it to `SIGNOUT_RELEASE_PATH`, which
  `proxy-core` now exports.
- WU5 → WU7: drive the flow through `createIamApp` (`membershipTransport: true`) as `terminal-identification.test.ts`
  does: `/auth/login` with the proxy's handoff and the terminal cookie → 302 to `<origin><identify>?identification=`;
  `HttpIamTerminals` (a membership transport key of the app) `assertIdentity` with a token whose `aud` is the app →
  `callbackUrl`; the proxy redeems its code with the verifier it set; sign-out → `/auth/terminals/release` → the next
  `/auth/login` opens a new identification.
- WU7: the witness is `packages/iam/src/__tests__/terminal-end-to-end.test.ts`, on IAM's SQLite harness and
  `createVerifyService` over the endpoint table a contract with `terminal: { identify }` compiles to. Control's side
  goes through IAM's own surfaces: the schema `PUT`, `workloads.issueKey` for the public procedure, `apps.setReturnOrigins`,
  `grants.create`, `terminals.setProfile` and `terminals.revoke`; only the membership transport key is written through
  the repository. The application is hand-written, not booted by the framework: a framework public procedure needs
  Postgres. Its procedure exchanges the public workload key at IAM and calls `HttpIamTerminals`, the client
  `ctx.terminals` uses on Bun, so the framework's dispatch to `ctx.terminals` stays covered by WU4's unit test only.
- WU7: a revoked terminal's session survives at the proxy until its cached token comes due, as every revocation does
  (ADR-0022 §4); the test moves the proxy's clock to show the bounce. After the release the old session is no longer
  active, and the next bounce opens a new identification.
- WU7: the decisions index row was already in place (`docs/decisions/README.md`). The reference entries are a
  "Terminals" section in `human-authentication.md`, "Step 3 on a terminal" and the sign-out rule in `cross-host-sso.md`,
  and the `ctx.terminals` and `ctx.principal.terminal` entries in `application-runtime.md`.
- Review fix 1: `assertIdentity` answers IAM's `/auth/terminals/complete?identification=<id>`, never a code; the
  completion issues the code only to the identification's own terminal cookie, once, within 60 s of the assertion,
  while the login is valid (migration `0025_terminal_completion.sql`: `session_id`, `completed_at`). The consumption and
  the login are one batch (`consumedFor` guards the login and its `auth_log` row), so a failed write leaves the
  identification open. The proxy spends a code that reaches its callback without a verifier cookie (`unmatchedVerifier`);
  that hardening applies to every handoff. It alone would not have been enough here: the asserter held the code and could
  redeem it before sending the browser anywhere.
- Review fix 2: on Cloudflare nothing identified the caller of a binding, so the identification operations trusted any
  token's `aud`. The deployer now wraps the application Worker's `IAM` binding (`IamApplicationReference`) so the
  generated service entry carries `props: { app: '<app>@<env>' }`; the platform proxy's binding carries the same. The
  bounds refuse an IAM binding whose `props` are not exactly this deployment's id, under any binding name.
  `PropustkaApplication` answers `not_allowed` unless `ctx.props.app` is the input's `app`. A Worker deployed before this
  carries no props, so its terminal calls are refused until it is redeployed.
- Review fix 3: a release (`terminals.release`, formerly `revokeSessions`) increments `terminals.generation`, ends the
  pending identifications and revokes the sessions in one transaction; a revocation ends pending identifications too
  (migration `0026_terminal_generation.sql`). An identification records its generation, the consumption requires it to
  be the terminal's, the login and its child carry it (`sessions.terminal_generation`), and the validity join requires
  it. No lock ordering is needed: a login written by an assertion that raced a release is invalid on arrival. Opus #2
  (a failed write lost the identification) was already closed by fix 1's guarded batch.
