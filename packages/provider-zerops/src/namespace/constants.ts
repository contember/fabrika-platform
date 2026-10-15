export const ZEROPS_NAMESPACE_PROXY_HOSTNAME = 'proxy'

export const ZEROPS_NAMESPACE_POSTGRES_HOSTNAME = 'postgres'

export const ZEROPS_NAMESPACE_IAM_ISSUER_VARIABLE = 'FABRIKA_IAM_ISSUER'

export const ZEROPS_NAMESPACE_IAM_KEY_VARIABLE = 'FABRIKA_IAM_KEY'

/** The platform-owned variable naming one URL per published HTTP port. READ_ONLY, written by Zerops. */
export const ZEROPS_NAMESPACE_SUBDOMAIN_VARIABLE = 'zeropsSubdomain'

/**
 * How an app reaches the namespace-owned PostgreSQL service as its own user `db` — port, database and TLS mode NAMED,
 * not defaulted. Every part settled against a live account, none of it safe to infer:
 *
 *   • `${x_connectionString}` is `postgresql://${user}:${password}@${hostname}:${port}` — no database path. With
 *     none, the libpq/postgres.js convention falls back to the USER name.
 *   • `dbName` and `user` are both literally `db` on EVERY PostgreSQL service, whatever its hostname (checked on a
 *     service named `wu2db`). `/${x_dbName}` says it out loud rather than relying on that fallback.
 *   • THE DIRECT PORT, NOT `portTls`. `portTls` (6432) is pgBouncer with a static user list: only `db`, `postgres` and
 *     `zps` log in there, and a role fabrika creates is refused (`08P01`, measured 2026-10-15). A contract
 *     application's runtime role reuses its database URL's host and port, so only the direct port serves it.
 *   • `sslmode=disable`, the one mode that connects on both service types: `postgresql:ha@18` answers `require` on the
 *     direct port with "Server does not support SSL", and `Bun.SQL`'s `prefer` waits out its 30 s connection timeout
 *     against a server without TLS instead of falling back. The direct port stays inside the project's network.
 *
 * A contract application does not connect with this: its `FABRIKA_APP_DATABASE_URL` names the service's superuser,
 * the provisioning credential of its role family (ADR-0017, `zeropsProvisioningDatabaseUrl` in `../manifest.ts`).
 */
export const ZEROPS_SHARED_POSTGRES_CONNECTION_STRING = '${postgres_connectionString}/${postgres_dbName}?sslmode=disable'
