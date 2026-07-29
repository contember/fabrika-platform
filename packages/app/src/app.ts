// ─── Application ─────────────────────────────────────────────────────
//
// `defineApp` owns the runtime-neutral Fetch request pipeline.

import { defaultOnError, jsonResponse } from './errors.js'
import type { Middleware } from './middleware.js'
import { runChain } from './middleware.js'
import { matchRoutes } from './router.js'
import type { Route } from './router.js'
import { dispatchRpcRequest } from './rpc/dispatcher.js'

/** Runtime-neutral background-work capability available while handling a request. */
export interface RequestExecutionContext {
	waitUntil(promise: Promise<unknown>): void
}

/** Something that can serve static assets (e.g. a Workers Assets binding). */
export interface AssetsLike {
	fetch(request: Request): Promise<Response>
}

export interface AppConfig<Env, Ctx> {
	/** Build the base per-request context. Auth is added later by middleware. */
	context: (env: Env, request: Request, exec: RequestExecutionContext) => Ctx | Promise<Ctx>
	/** Middleware, run in declared order around the inner dispatch. */
	middleware?: (env: Env) => Middleware<Ctx>[]
	/** HTTP + RPC routes. */
	routes: Route<Ctx>[]
	/** SPA fallback served for an unmatched GET. */
	assets?: (env: Env) => AssetsLike
	/** Map a thrown value to a `Response`. Defaults to `defaultOnError`. */
	onError?: (err: unknown, request: Request, env: Env) => Response
}

export interface FabrikaApp<Env> {
	fetch(request: Request, env: Env, exec: RequestExecutionContext): Promise<Response>
}

function createFetch<Env, Ctx>(
	config: AppConfig<Env, Ctx>,
): (request: Request, env: Env, exec: RequestExecutionContext) => Promise<Response> {
	const onError = config.onError ?? defaultOnError

	return async (request: Request, env: Env, exec: RequestExecutionContext): Promise<Response> => {
		try {
			const ctx = await config.context(env, request, exec)
			const middleware = config.middleware ? config.middleware(env) : []

			const dispatch = async (): Promise<Response> => {
				const matched = matchRoutes(config.routes, request)
				if (matched) {
					const inner = (): Promise<Response> => {
						if (matched.route.kind === 'rpc') {
							return dispatchRpcRequest({ router: matched.route.router, ctx, request })
						}
						return Promise.resolve(matched.route.handler(ctx, matched.params))
					}
					// Route-scoped middleware run after the global chain, around the handler.
					return runChain(request, ctx, matched.route.use, inner)
				}
				if (request.method === 'GET' && config.assets) {
					return config.assets(env).fetch(request)
				}
				return jsonResponse({ error: { type: 'not_found', message: 'Not found' } }, 404)
			}

			return await runChain(request, ctx, middleware, dispatch)
		} catch (err) {
			return onError(err, request, env)
		}
	}
}

export function defineApp<Env, Ctx>(config: AppConfig<Env, Ctx>): FabrikaApp<Env> {
	return { fetch: createFetch(config) }
}
