export const ZEROPS_NAMESPACE_PROXY_HOSTNAME = 'proxy'

export const ZEROPS_NAMESPACE_POSTGRES_HOSTNAME = 'postgres'

export const ZEROPS_NAMESPACE_IAM_ISSUER_VARIABLE = 'FABRIKA_IAM_ISSUER'

export const ZEROPS_NAMESPACE_IAM_KEY_VARIABLE = 'FABRIKA_IAM_KEY'

/** The platform-owned variable naming one URL per published HTTP port. READ_ONLY, written by Zerops. */
export const ZEROPS_NAMESPACE_SUBDOMAIN_VARIABLE = 'zeropsSubdomain'

/**
 * How an app reaches the namespace-owned PostgreSQL service — port, database and TLS mode NAMED, not
 * defaulted. Every part settled against a live account, none of it safe to infer:
 *
 *   • `${x_connectionTlsString}` is `postgresql://${user}:${password}@${hostname}:${portTls}` — no
 *     database path. With none, the libpq/postgres.js convention falls back to the USER name.
 *   • `dbName` and `user` are both literally `db` on EVERY PostgreSQL service, whatever its hostname
 *     (checked on a service named `wu2db`). So the fallback lands right today — by construction rather
 *     than by luck, but still by a rule nobody wrote down. `/${x_dbName}` says it out loud.
 *   • THE TLS PORT, NOT THE DIRECT ONE, and this is the one that changed. `postgresql:single@18`
 *     speaks TLS on both; `postgresql:ha@18` speaks it ONLY on `portTls` and answers `sslmode=require`
 *     on the direct port with "Server does not support SSL". A namespace picks `ha` for `prod` and
 *     `single` everywhere else, so a DSN naming the direct port is one preset away from failing.
 *   • `portTls` preserves SESSION state on both — same backend pid across statements, `SET SESSION`
 *     kept, advisory lock held and visible — so the migration runner's session-level lock is safe
 *     there. It is a TLS endpoint, not the transaction pool the port number suggests.
 *   • `verify-full` fails (`self signed certificate`), so `require` is the strongest mode available.
 */
export const ZEROPS_SHARED_POSTGRES_CONNECTION_STRING = '${postgres_connectionTlsString}/${postgres_dbName}?sslmode=require'
