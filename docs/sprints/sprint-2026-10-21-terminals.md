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
- WU2: the ceiling is a set of global `permits` patterns, so a person's wildcard entry (`*`, `x.*`) survives only under a
  ceiling pattern that matches the wildcard string itself; contract applications hold exact actions, so this rarely bites.
- WU2: `mintToken` also refuses a terminal session for a platform audience, even as its asserter, and when the terminal
  principal is disabled or the profile no longer lists the asserter. `exchangeAuthCode` refuses (`wrong_app`) a code
  issued for an app other than the login's `asserted_by`.
- WU2 → WU4/WU5: a `perms` entry with source `terminal` makes an older `parseAccessClaims` refuse the whole token
  (`parseSource` is closed). Only an application whose framework knows terminals may be an asserter; WU5's "declares an
  identification page" check is what enforces that.
