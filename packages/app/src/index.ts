// @fabrika/app — the first-party server framework for Fabrika applications:
// Fetch-based HTTP routing, typed RPC, middleware, and object-level authorization.

// ─── RPC ─────────────────────────────────────────────────────────────
export { initRpc } from './rpc/builder.js'
export type { InferRouter, InferRouterClient } from './rpc/types.js'

// ─── Schema contract (validator-agnostic) ────────────────────────────
export type { StandardSchemaV1 } from './standard-schema.js'

// ─── Routing ─────────────────────────────────────────────────────────
export { matchRoutes, route } from './router.js'
export type { HttpMethod, HttpRoute, Route, RouteOptions, RouteParams, RpcRoute } from './router.js'

// ─── Application ─────────────────────────────────────────────────────
export { defineApp } from './app.js'
export type { AppConfig, AssetsLike, FabrikaApp, RequestExecutionContext } from './app.js'

// ─── Errors ──────────────────────────────────────────────────────────
export {
	BadRequestError,
	ConflictError,
	defaultOnError,
	ForbiddenError,
	HttpError,
	NotFoundError,
	toErrorResponse,
	UnauthorizedError,
} from './errors.js'

// ─── Middleware + auth contract ──────────────────────────────────────
export type { AuthContext, Scope } from '@fabrika/auth'
export type { Middleware } from './middleware.js'

// ─── Client ──────────────────────────────────────────────────────────
export { createRpcClient, RpcError } from './client.js'
export type { RpcClientOptions } from './client.js'
