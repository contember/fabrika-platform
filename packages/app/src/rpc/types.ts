// ─── RPC core types ──────────────────────────────────────────────────
//
// A minimal tRPC-like engine. A router is a (possibly nested) map of procedures;
// a procedure carries an input schema, an OPTIONAL output schema, an authz
// requirement list, and a handler. The server-facing type is `InferRouter`; the
// client call types are `InferRouterClient`.

import type { AuthContext, Scope } from '@fabrika/auth'
import type { StandardSchemaV1 } from '../standard-schema.js'

/** `query` and `mutation` are metadata today — the dispatcher treats them identically. */
export type ProcedureKind = 'query' | 'mutation'

/**
 * A recorded authorization requirement. `scopeResolver` is declared as a METHOD
 * (bivariant params) on purpose, so a concrete `Procedure<C, I, O>` stays
 * assignable to `AnyProcedure`.
 */
export interface AuthRequirement<TContext, TInput> {
	readonly action: string
	scopeResolver?(input: TInput, ctx: TContext): Scope | undefined
}

// `TInput` is the schema's PARSED (output) type — what the handler receives and what the client is
// typed to send. Modeled as `StandardSchemaV1<unknown, TInput>` (output param = TInput); for plain
// schemas input === output, so the single param is faithful.
export interface Procedure<TContext, TInput, TOutput> {
	readonly _tag: 'procedure'
	readonly kind: ProcedureKind
	readonly input: StandardSchemaV1<unknown, TInput>
	readonly output: StandardSchemaV1<unknown, TOutput> | null
	readonly requirements: ReadonlyArray<AuthRequirement<TContext, TInput>>
	handler(args: { ctx: TContext; input: TInput }): Promise<TOutput> | TOutput
}

export interface AnyProcedure {
	readonly _tag: 'procedure'
	readonly kind: ProcedureKind
	readonly input: StandardSchemaV1
	readonly output: StandardSchemaV1 | null
	readonly requirements: ReadonlyArray<AuthRequirement<unknown, unknown>>
	handler(args: { ctx: unknown; input: unknown }): Promise<unknown> | unknown
}

export type RouterDef = {
	readonly [key: string]: AnyProcedure | AnyRouter
}

export interface Router<TDef extends RouterDef> {
	readonly _tag: 'router'
	readonly _def: TDef
}

export type AnyRouter = Router<RouterDef>

/** Re-export the auth contract used by procedure requirements. */
export type { AuthContext, Scope }

// ─── Inference ───────────────────────────────────────────────────────

/** Server-facing view of a router: each procedure as its handler signature. */
export type InferRouter<TRouter> = TRouter extends { _tag: 'router'; _def: infer TDef } ? TDef extends RouterDef ? {
			[K in keyof TDef]: TDef[K] extends Procedure<infer C, infer I, infer O> ? (args: { ctx: C; input: I }) => Promise<O> | O
				: TDef[K] extends Router<RouterDef> ? InferRouter<TDef[K]>
				: never
		}
	: never
	: never

/** Client-facing view of a router: each procedure as `(input) => Promise<output>`. */
export type InferRouterClient<TRouter> = TRouter extends { _tag: 'router'; _def: infer TDef } ? TDef extends RouterDef ? {
			[K in keyof TDef]: TDef[K] extends Procedure<unknown, infer I, infer O> ? (input: I) => Promise<O>
				: TDef[K] extends Router<RouterDef> ? InferRouterClient<TDef[K]>
				: never
		}
	: never
	: never
