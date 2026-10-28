// The names the Cloudflare provider and the application's Worker share (ADR-0065); `@fabrika/app/build` exports them.

/** The Durable Object class the Cloudflare entry exports: one object per application environment runs it (ADR-0065). */
export const CLOUDFLARE_APPLICATION_CLASS = 'FabrikaApplication'

/** The binding through which the application's Worker reaches its object. */
export const CLOUDFLARE_APPLICATION_BINDING = 'FABRIKA_APPLICATION'

/** The R2 bucket binding of the environment's stored files. */
export const CLOUDFLARE_FILES_BINDING = 'FABRIKA_FILES'

/**
 * The Workers Assets binding the SPA and link mounts serve their files from. Its directory mirrors the request paths:
 * the mount `/admin` serves `<directory>/admin/…`, the root mount `<directory>/…`.
 */
export const CLOUDFLARE_ASSETS_BINDING = 'ASSETS'

/** The Hyperdrive binding through which the Worker of an application on Postgres reaches its database. */
export const CLOUDFLARE_DATABASE_BINDING = 'FABRIKA_DATABASE'
