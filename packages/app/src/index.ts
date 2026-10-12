// @fabrika/app — the first-party server framework: typed RPC, its client, structural errors, and the `{ fetch }` the
// runtime adapters serve. A contract application uses `@fabrika/app/contract`; an installation service
// `@fabrika/app/service`.

// ─── RPC ─────────────────────────────────────────────────────────────
export { initRpc } from './rpc/builder.js'
export type { InferRpcClient, InferRpcContractClient, RpcProcedureContract, RpcRouterFor } from './rpc/contract.js'
export type { InferRouter, InferRouterClient } from './rpc/types.js'

// ─── Schema contract (validator-agnostic) ────────────────────────────
export type { StandardSchemaV1 } from './standard-schema.js'

// ─── Request handling ────────────────────────────────────────────────
export type { FetchService, RequestExecutionContext } from './fetch.js'

// ─── Errors ──────────────────────────────────────────────────────────
export {
	BadRequestError,
	ConflictError,
	defaultOnError,
	ForbiddenError,
	HttpError,
	isStructuralError,
	NotFoundError,
	type StructuralError,
	toErrorResponse,
	UnauthorizedError,
} from './errors.js'

// ─── Rows ────────────────────────────────────────────────────────────
export { fromPage, fromRow, type RowInput } from './from-row.js'

// ─── Auth contract ───────────────────────────────────────────────────
export type { AuthContext, Scope } from '@fabrika/auth'

// ─── Client ──────────────────────────────────────────────────────────
export { createRpcClient } from './client/rpc.js'
export type { RpcClientOptions } from './client/rpc.js'
export { RpcError, type RpcFetch } from './client/transport.js'
