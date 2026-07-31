// ─── Portable RPC contract ───────────────────────────────────────────
//
// Contracts carry only procedure input and output types. A browser-safe contract
// package can therefore describe an API without importing its server router,
// validators, handler context, or runtime dependencies.

import type { InferRouterClient, Procedure, Router, RouterDef } from './types.js'

/** A type-only RPC procedure declaration for a portable API contract. */
export interface RpcProcedureContract<TInput, TOutput> {
	readonly '~rpc': {
		readonly input: TInput
		readonly output: TOutput
	}
}

/** Client-facing view of a portable contract. */
export type InferRpcContractClient<TContract> = TContract extends RpcProcedureContract<infer TInput, infer TOutput>
	? (input: TInput) => Promise<TOutput>
	: TContract extends object ? { [K in keyof TContract]: InferRpcContractClient<TContract[K]> }
	: never

/** Client-facing view of either a server router or a portable contract. */
export type InferRpcClient<TApi> = TApi extends { readonly _tag: 'router'; readonly _def: RouterDef } ? InferRouterClient<TApi>
	: InferRpcContractClient<TApi>

type RpcRouterDefinition<TContext, TContract> = {
	readonly [K in keyof TContract]: TContract[K] extends RpcProcedureContract<infer TInput, infer TOutput> ? Procedure<TContext, TInput, TOutput>
		: TContract[K] extends object ? RpcRouterFor<TContext, TContract[K]>
		: never
}

/** Server router shape required to implement a portable contract. */
export type RpcRouterFor<TContext, TContract> = Router<RpcRouterDefinition<TContext, TContract>>
