# @fabrika/iam

The Access service: SSO and password login, session and `px_` credential custody, per-app token
minting, the `/admin` API, and the audit log. It runs on **two** targets — a Cloudflare
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
- **Never log a secret, a key, or an error object that may quote a connection string.** Log which
  surfaces are enabled, not what enabled them.

## Patterns

- Minting is two fronts over one resolve→sign core (`src/tokens.ts`): `mintToken` from the browser's
  opaque `px_session` cookie, `mintFromKey` from a `px_` credential. Both end in `signAccessToken`,
  so this runs about once per TTL per app — not per request.
- Human authentication methods compose (ADR-0020); password support is `src/password-*.ts` and its
  transient rows are pruned by the same cron as `auth_log`.
- Background work goes through the `WaitUntil` port, so a Worker's `scheduled` writes settle and a
  process logs a failure instead of dying on an unhandled rejection.
