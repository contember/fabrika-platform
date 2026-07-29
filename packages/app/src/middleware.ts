// ─── Middleware ──────────────────────────────────────────────────────
//
// @fabrika/auth owns the request-time contracts. The app framework consumes and
// re-exports them instead of maintaining a structurally duplicated copy.

import type { Middleware } from '@fabrika/auth'

export type { Middleware } from '@fabrika/auth'

/**
 * A middleware runs in declared order around the inner dispatch. It may mutate
 * `ctx` (e.g. set `ctx.auth`), short-circuit by returning a `Response` without
 * calling `next()`, or wrap `next()` (await it, then mutate the `Response`, e.g.
 * append a `Set-Cookie`).
 */
/**
 * Fold `middleware` (in declared order) around an innermost `dispatch`. Each
 * middleware receives a `next` that advances to the following one; the last
 * `next` calls `dispatch`.
 */
export function runChain<Ctx>(
	request: Request,
	ctx: Ctx,
	middleware: ReadonlyArray<Middleware<Ctx>>,
	dispatch: () => Promise<Response>,
): Promise<Response> {
	let lastIndex = -1
	const run = (index: number): Promise<Response> => {
		if (index <= lastIndex) {
			return Promise.reject(new Error('next() called multiple times in a single middleware'))
		}
		lastIndex = index
		const current = middleware[index]
		if (!current) return dispatch()
		return current(request, ctx, () => run(index + 1))
	}
	return run(0)
}
