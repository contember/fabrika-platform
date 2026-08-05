# @fabrika/iam

The Access service: SSO and password login, session and `px_` credential custody, per-app token
minting, the administration API, and the audit log. It runs on **two** targets — a Cloudflare
`WorkerEntrypoint` and a long-running Bun process — from one shared body of code. Assumes the root
CLAUDE.md. Browser-safe admin DTOs live in `@fabrika/iam-contract`; the `IamRpc` contract, policy
evaluation, and token shapes live in `@fabrika/auth-core`.

## Commands (this package)

```bash
bun run dev                 # lopata dev on :18191
bun run oblaka              # regenerate wrangler.jsonc — never hand-edit it
bun run serve               # the long-running Bun server (src/node/server.ts)
bun run migrate:postgres    # apply migrations-postgres/
bun run prune:auth-log      # the cron one-shot (platform crontab drives this, not a timer)
bun test src/__tests__/entrypoint-isolation.test.ts   # the import-graph guard, below
```

## Two entrypoints, one body of code

|            | Cloudflare                                | Bun process                                      |
| ---------- | ----------------------------------------- | ------------------------------------------------ |
| entrypoint | `src/index.ts` (`cloudflare:workers`)     | `src/node/server.ts` (`Bun.serve`)               |
| `IamRpc`   | service binding on the `WorkerEntrypoint` | HTTP via `src/rpc-http.ts`, shared-secret gated  |
| cron       | `scheduled()` → `runIamMaintenance`       | platform crontab → `src/node/prune.ts`           |
| migrations | `migrations/` (SQLite/D1)                 | `migrations-postgres/` via `src/node/migrate.ts` |

`src/app.ts` (routes), `src/rpc.ts` (the `IamRpc` object), and `src/cron.ts` are the shared layer and
import **neither** runtime. `src/index.ts` is the only file that may import `cloudflare:workers`;
everything under `src/node/` is the only code that may import `bun:*`/`node:*` or
`@fabrika/platform-node`. `src/__tests__/entrypoint-isolation.test.ts` walks both import graphs and
fails if that stops being true — it is the guard, not documentation of one.

## Invariants

- **Only the SHA-256 hash of a credential is stored** (`src/secret.ts`), for API keys, share links,
  and SSO sessions alike. Plaintext is shown once at issue. Compare digests with
  `timingSafeEqualHex`, never raw secrets.
- **ONE MAILBOX RULE. `principals.email` is the NORMALIZED mailbox and nothing else; the spelling a
  human or an IdP used lives in `label`.** `PrincipalRepository` is the only place that applies
  `normalizeEmailIdentity`, so every caller may hand it any spelling, and every comparison is plain
  equality. Never ask the engine to case-fold an identity — SQLite's `LOWER()` is ASCII-only where
  Postgres's is full Unicode, so `LOWER(email) = LOWER(?)` used to make the BACKEND decide whether two
  addresses were one person. `principal_email_claims` is the second lock over the same rule and moves
  with a principal whose address changes; migration `0011`/`0005` normalized every legacy row and
  REFUSES to run on data it cannot fold identically on both engines.
- **The OIDC flight cookie is signed** (`Signer.signInternal`, audience `fabrika:iam:oidc-flight`).
  Its `state` cannot authenticate itself — whoever writes the cookie writes `state` too — and
  `Path=/auth` does not stop a sibling host under a shared domain from tossing in a second one. Every
  terminal outcome of `/auth/callback`, success or failure, clears it.
- **ADMINISTRATION HAS ONE TRANSPORT. `/admin/*` REST IS A CLOSED PROVISIONING SURFACE.** Four
  operations: `GET|PUT /admin/apps/:app/schema` (a deploy's `reconcileSchema`, which runs outside
  the installation and has no service binding) and `POST /admin/api-keys` +
  `DELETE /admin/api-keys/:principalId` (the first machine caller, bootstrapped before a console
  exists). Every other `/admin/*` path is 404. About two dozen REST operations used to mirror
  `/admin/rpc` procedure for procedure with no caller at all, and each was a second place a gate
  could be forgotten (SEC-11) or an internal message could leak (CORR-4). Adding a route back means
  showing no `/admin/rpc` procedure can serve the caller — otherwise "policy, audit and
  hidden-object behaviour must not diverge by transport" becomes a property somebody has to
  maintain again. `extractCredentials`/`rejectCrossOrigin`/`resolveAdmin` live in `admin/router.ts`
  and are shared by both, so admission is decided once.
- **REVOKING AN IAM SESSION REVOKES EVERY APP SESSION DERIVED FROM IT, AND THAT IS A JOIN, NOT A
  SWEEP.** `getActiveSessionByHash`/`ById` join to `parent_session_id` on every lookup, so a child
  stops resolving the moment the parent carries `revoked_at` — its own row is never rewritten, which
  is why `sessions.revoke` is one statement and why a child can read `active` in `sessions.list`
  while its parent is dead. Never "fix" that by walking children: IAM cannot set a cookie on the
  hosts they belong to, and the walk would be the thing that races.
- **WHICH BROWSER ORIGINS MAY DRIVE `/admin/*` IS A REGISTRY, NOT AN INFERENCE.** `ADMIN_ORIGINS`
  (deploy var `FABRIKA_IAM_ADMIN_ORIGINS`) holds the CONSOLE's public origin — the control plane's
  domain, which IAM has no way to derive. It used to compare `Origin` against its own issuer, which a
  console request never carries, and the gateway rewrote the header to compensate; every deployment
  whose private RPC address differed from its public issuer answered 403 to the whole Access plane.
  Empty means no browser may write, which is fail-closed. A caller presenting ONLY a bearer is exempt
  (a browser never attaches one by itself), which is what keeps CI and the first-operator bootstrap
  working. The method list in `rejectCrossOrigin` is an ALLOWLIST of safe methods, so a method
  invented later is checked by default.
- **A `px_` CREDENTIAL IS BOUND TO AN APP.** `credentials.app` is what `resolveCredential` checks at
  every mint. It is REQUIRED on an anonymous credential (a share link): its inline grants are frozen
  at issue and were delegation-checked against one app, so without the binding authority granted at
  one app was spendable installation-wide. A principal-bound credential may be cross-app (`NULL`) —
  it carries no frozen authority and its permissions resolve per app through `grants`. An app
  mismatch is reported as `invalid_key`, never as a distinct reason. Migration `0012`/`0006` is a
  hard cutover: pre-existing share links have no app and must be reissued.
- **A self-bound key (`issueKey` in `principalId` mode) MUST state an expiry.** It carries the
  issuer's live permissions with no inline downscope, so without one a 300-second passthrough token
  could mint a permanent installation-wide credential from itself.
- **A mutating auth route requires `sameOrigin`, `/auth/logout` included.** `px_session` is
  `SameSite=Lax`, so a cross-site top-level GET carried it; GET renders a confirm form, POST acts.
  Every 302 out of `src/auth/**` carries `cache-control: no-store` — those are the responses holding
  the session cookie and the single-use handoff code.
- **Signing keys come from `FABRIKA_IAM_SIGNING_KEYS`** (a JSON array of private JWKs). Index 0 is
  the active signer; every key is published in the JWKS so a rotation key verifies before it is
  promoted. With no keys configured an EPHEMERAL key is generated per isolate — fine for dev,
  refused on stage/prod.
- **NO KEY MEANS NO SURFACE.** An unset `rpcKey`/`proxyKey` makes the HTTP transports 404 as if they
  were never mounted. There is no path in which the check is skipped, and a misconfigured deploy
  loses RPC rather than publishing it.
- **The RPC shared secret is TRANSPORT auth, not caller identity.** It replaces what a service
  binding's unreachability gives on Workers, and does not substitute for the per-caller
  authorization the management RPCs already do. Never reuse `FABRIKA_IAM_PROVISIONING_KEY` for it —
  that key resolves to a synthetic global admin.
- **A DEPLOY NEVER OVERWRITES AN ADMIN'S POLICY.** `putAppSchema` 409s when a declared role key
  already exists as an `origin='custom'` row — symmetric with `createPolicyUseCase`, which 409s on an
  existing app role. `reconcileAppSchema`'s upsert carries `WHERE roles.origin = 'app'` as the second
  lock. Without both, a deploy flipped a custom policy to `origin='app'`, after which update and
  delete require `origin='custom'` and 404, and the policy became unmanageable.
- **A reconcile CLEARS THEN WRITES, so no statement's width depends on the catalog.** D1 allows 100
  bound parameters per query and the old `NOT IN (…)` prune spent one per kept value; an app with a
  hundred actions could not reconcile at all. The batch is one transaction, so there is no window in
  which the app has no vocabulary.
- **Permission resolution is fail-closed and pure.** `computePermissions` (`src/resolve.ts`) takes
  already-fetched rows, so it is unit-testable without a database. Unparseable inline grant JSON and
  an unresolvable role key both contribute ZERO permissions. Wildcards stay as patterns — `permits()`
  in `@fabrika/auth-core` matches them; never pre-expand.
- **The session cookie's `Secure` flag comes from the configured public issuer, never from the
  request protocol.** Behind a TLS-terminating balancer the socket is the wrong signal.
- **Both migration sets must land the same OUTCOME.** `migrations/` is immutable SQLite history;
  `migrations-postgres/` states the final schema once. `src/db.ts` runs unmodified against both, and
  `src/__tests__/postgres-schema.test.ts` pins it against a real database. Add a change to both,
  knowingly. Bundle `iam`, its ledger, and advisory lock `7214839201` are durable identity (ADR-0017).
  A migration that cannot state a correct outcome for existing rows REFUSES rather than guesses —
  `src/__tests__/migration-guards.test.ts` proves both engines refuse the same data. Note that Bun's
  `Database.exec()` swallows a step error and runs on, so that test applies the file one statement at
  a time, the way `wrangler d1 migrations apply` does.
- **Never log a secret, a key, or an error object that may quote a connection string.** Log which
  surfaces are enabled, not what enabled them. `src/log.ts` (`logError`/`logWarn`) is the ONE place a
  caught value becomes a log line, and it emits only an `Error`'s own message — a driver error
  carries the DSN it failed on and a fetch error carries the URL. Never pass a caught value to
  `console.*` directly.
- **OIDC configuration is FATAL when incomplete, on both engines.** `buildOidc` requires
  `OIDC_ISSUER`/`OIDC_CLIENT_ID`/`OIDC_CLIENT_SECRET` whenever the method is enabled. The Bun path
  always did; the Worker substituted empty strings and served a method that could only fail at the
  redirect. Refusing to boot beats booting misconfigured — so a local `wrangler dev` is password-only.

## Patterns

- Minting is two fronts over one resolve→sign core (`src/tokens.ts`): `mintToken` from the browser's
  opaque `px_session` cookie, `mintFromKey` from a `px_` credential. Both end in `signAccessToken`,
  so this runs about once per TTL per app — not per request.
- Human authentication methods compose (ADR-0020); password support is `src/password-*.ts` and its
  transient rows are pruned by the same cron as `auth_log`.
- Every admin list is a PAGE: `before` (a keyset cursor over the UUIDv7 id) + `limit`, one query for
  the page and one for its fan-out. `principalStatus` is expressed in SQL rather than filtered after
  the read, because filtering afterwards made `limit` mean nothing. `cron.test.ts` asserts a row count
  per table, so adding or dropping a table the sweep owns is a visible test change.
- Background work goes through the `WaitUntil` port, so a Worker's `scheduled` writes settle and a
  process logs a failure instead of dying on an unhandled rejection.
