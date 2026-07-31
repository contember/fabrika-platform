// ─── HTTP routing ────────────────────────────────────────────────────
//
// A tiny method-aware path router. HTTP routes carry a `(ctx, params) => Response`
// handler; RPC routes carry a `Router`. Params are inferred from the pattern
// string literal: `/api/:project/envelope` → `{ project: string }`.

import type { Middleware } from './middleware.js'
import type { AnyRouter } from './rpc/types.js'

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/** Per-route options. `use` middleware run AFTER the global chain, scoped to this route only. */
export interface RouteOptions<Ctx> {
	readonly use?: ReadonlyArray<Middleware<Ctx>>
}

/** Extract `:param` and terminal `*rest` names from a pattern literal. */
export type RouteParams<Pattern extends string> = Pattern extends `${infer _Head}:${infer Param}/${infer Rest}`
	? Record<Param, string> & RouteParams<Rest>
	: Pattern extends `${infer _Head}:${infer Param}` ? Record<Param, string>
	: Pattern extends `${infer _Head}*${infer Rest}` ? Rest extends '' ? {} : Record<Rest, string>
	: {}

export type HttpHandler<Ctx, Pattern extends string> = (ctx: Ctx, params: RouteParams<Pattern>) => Response | Promise<Response>

export interface HttpRoute<Ctx, Pattern extends string = string> {
	readonly kind: 'http'
	/** `null` matches every method and is intended for mounting an existing Fetch handler. */
	readonly method: HttpMethod | null
	readonly pattern: Pattern
	readonly segments: ReadonlyArray<string>
	readonly use: ReadonlyArray<Middleware<Ctx>>
	handler(ctx: Ctx, params: RouteParams<Pattern>): Response | Promise<Response>
}

export interface RpcRoute<Ctx> {
	readonly kind: 'rpc'
	readonly pattern: string
	readonly segments: ReadonlyArray<string>
	readonly use: ReadonlyArray<Middleware<Ctx>>
	readonly router: AnyRouter
}

export type Route<Ctx> = HttpRoute<Ctx, string> | RpcRoute<Ctx>

function splitPath(path: string): string[] {
	return path.split('/').filter((segment) => segment.length > 0)
}

function decodePathSegment(segment: string): string | null {
	try {
		return decodeURIComponent(segment)
	} catch {
		return null
	}
}

function makeHttpRoute<Ctx, Pattern extends string>(
	method: HttpMethod | null,
	pattern: Pattern,
	handler: HttpHandler<Ctx, Pattern>,
	opts: RouteOptions<Ctx> | undefined,
): HttpRoute<Ctx, Pattern> {
	const segments = splitPath(pattern)
	const wildcard = segments.findIndex((segment) => segment.startsWith('*'))
	if (wildcard !== -1 && wildcard !== segments.length - 1) {
		throw new Error('a wildcard route segment must be terminal')
	}
	return { kind: 'http', method, pattern, segments, use: opts?.use ?? [], handler }
}

/**
 * Route builders. HTTP verbs take `(pattern, handler, opts?)`; `rpc` mounts a
 * `Router` at a path. Annotate the handler's `ctx` (or place the route in a
 * `Route<Ctx>[]`) to type the context. `opts.use` adds route-scoped middleware
 * (run after the global chain) — e.g. a capability/api-key gate on one path group.
 */
export const route = {
	all<Ctx, Pattern extends string>(pattern: Pattern, handler: HttpHandler<Ctx, Pattern>, opts?: RouteOptions<Ctx>): HttpRoute<Ctx, Pattern> {
		return makeHttpRoute(null, pattern, handler, opts)
	},
	get<Ctx, Pattern extends string>(pattern: Pattern, handler: HttpHandler<Ctx, Pattern>, opts?: RouteOptions<Ctx>): HttpRoute<Ctx, Pattern> {
		return makeHttpRoute('GET', pattern, handler, opts)
	},
	post<Ctx, Pattern extends string>(pattern: Pattern, handler: HttpHandler<Ctx, Pattern>, opts?: RouteOptions<Ctx>): HttpRoute<Ctx, Pattern> {
		return makeHttpRoute('POST', pattern, handler, opts)
	},
	put<Ctx, Pattern extends string>(pattern: Pattern, handler: HttpHandler<Ctx, Pattern>, opts?: RouteOptions<Ctx>): HttpRoute<Ctx, Pattern> {
		return makeHttpRoute('PUT', pattern, handler, opts)
	},
	patch<Ctx, Pattern extends string>(pattern: Pattern, handler: HttpHandler<Ctx, Pattern>, opts?: RouteOptions<Ctx>): HttpRoute<Ctx, Pattern> {
		return makeHttpRoute('PATCH', pattern, handler, opts)
	},
	delete<Ctx, Pattern extends string>(pattern: Pattern, handler: HttpHandler<Ctx, Pattern>, opts?: RouteOptions<Ctx>): HttpRoute<Ctx, Pattern> {
		return makeHttpRoute('DELETE', pattern, handler, opts)
	},
	rpc<Ctx>(path: string, router: AnyRouter, opts?: RouteOptions<Ctx>): RpcRoute<Ctx> {
		return { kind: 'rpc', pattern: path, segments: splitPath(path), use: opts?.use ?? [], router }
	},
}

function matchSegments(routeSegments: ReadonlyArray<string>, pathSegments: ReadonlyArray<string>): Record<string, string> | null {
	const params: Record<string, string> = {}
	for (let i = 0; i < routeSegments.length; i++) {
		const routeSegment = routeSegments[i]
		if (routeSegment === undefined) return null
		if (routeSegment.startsWith('*')) {
			const name = routeSegment.slice(1)
			if (name !== '') {
				const decoded: string[] = []
				for (const segment of pathSegments.slice(i)) {
					const value = decodePathSegment(segment)
					if (value === null) return null
					decoded.push(value)
				}
				params[name] = decoded.join('/')
			}
			return params
		}
		const pathSegment = pathSegments[i]
		if (pathSegment === undefined) return null
		if (routeSegment.startsWith(':')) {
			const value = decodePathSegment(pathSegment)
			if (value === null) return null
			params[routeSegment.slice(1)] = value
		} else if (routeSegment !== pathSegment) {
			return null
		}
	}
	return routeSegments.length === pathSegments.length ? params : null
}

/** Find the first route matching the request's method + path. RPC routes match POST. */
export function matchRoutes<Ctx>(
	routes: ReadonlyArray<Route<Ctx>>,
	request: Request,
): { route: Route<Ctx>; params: Record<string, string> } | null {
	const pathSegments = splitPath(new URL(request.url).pathname)
	for (const candidate of routes) {
		if (candidate.kind === 'rpc') {
			if (request.method !== 'POST') continue
		} else if (candidate.method !== null && request.method !== candidate.method) {
			continue
		}
		const params = matchSegments(candidate.segments, pathSegments)
		if (params) return { route: candidate, params }
	}
	return null
}
