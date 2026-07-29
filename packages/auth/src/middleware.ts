/**
 * The shared middleware contract consumed by `@fabrika/app`. The auth package owns
 * the shape so middleware produced by `createIam(...)` drops directly into the
 * application request pipeline without a duplicate compatibility interface.
 *
 * A middleware runs in order; it may:
 *   - mutate `ctx` (e.g. set `ctx.auth`),
 *   - short-circuit by returning a Response WITHOUT calling `next()`,
 *   - or wrap `next()` — await it, then append headers (e.g. a `Set-Cookie`) to the returned Response.
 */

import type { AuthContext } from './types'

/**
 * A request-pipeline middleware over a caller-owned context `Ctx`. Runs in registration order. Return
 * a Response without awaiting `next()` to short-circuit; await `next()` and return its (possibly
 * header-augmented) Response to continue.
 */
export type Middleware<Ctx> = (request: Request, ctx: Ctx, next: () => Promise<Response>) => Promise<Response>

/**
 * The minimal shape an auth middleware needs of the pipeline context: a writable `auth` slot it sets to
 * the resolved `AuthContext` (or leaves null/undefined for an unresolved/anonymous caller). The
 * caller's real context may carry far more — this is only what the auth middlewares touch.
 */
export interface AuthCarrier {
	auth?: AuthContext | null
}
