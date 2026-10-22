// The names the Cloudflare provider and the application's Worker share (ADR-0065); `@fabrika/app/build` exports them.

/** The Durable Object class the Cloudflare entry exports: one object per application environment runs it (ADR-0065). */
export const CLOUDFLARE_APPLICATION_CLASS = 'FabrikaApplication'

/** The binding through which the application's Worker reaches its object. */
export const CLOUDFLARE_APPLICATION_BINDING = 'FABRIKA_APPLICATION'

/** The R2 bucket binding of the environment's stored files. */
export const CLOUDFLARE_FILES_BINDING = 'FABRIKA_FILES'
