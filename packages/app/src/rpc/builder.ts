// ─── RPC builder ─────────────────────────────────────────────────────
//
// `initRpc<Ctx>()` returns a `procedure` builder bound to the context type plus a
// `router` factory. Builders are immutable — each step returns a fresh builder.
//
// Two builder shapes keep the output type honest WITHOUT any cast:
//   - ProcedureBuilder (no output schema): the terminal infers the output type
//     from the handler's return — `t.procedure.input(X).query(() => ({ a: 1 }))`
//     gives the client `{ a: number }`, tRPC-style, no `.output()` needed.
//   - OutputProcedureBuilder (after `.output(schema)`): the terminal FIXES the
//     output to the schema type and validates the handler result at runtime.

import type { AuthContext, Scope } from '@fabrika/auth'
import type { StandardSchemaV1 } from '../standard-schema.js'
import type { AuthRequirement, Procedure, ProcedureKind, Router, RouterDef } from './types.js'

// The implicit input schema for a procedure with no `.input()` — accepts only "no input".
const voidSchema: StandardSchemaV1<unknown, void> = {
	'~standard': {
		version: 1,
		vendor: 'fabrika',
		validate: (input) => (input === undefined || input === null ? { value: undefined } : { issues: [{ message: 'Expected no input' }] }),
	},
}

type Handler<TContext, TInput, TOutput> = (args: { ctx: TContext; input: TInput }) => TOutput | Promise<TOutput>

function makeProcedure<TContext, TInput, TOutput>(
	kind: ProcedureKind,
	input: StandardSchemaV1<unknown, TInput>,
	output: StandardSchemaV1<unknown, TOutput> | null,
	requirements: ReadonlyArray<AuthRequirement<TContext, TInput>>,
	handler: Handler<TContext, TInput, TOutput>,
): Procedure<TContext, TInput, TOutput> {
	return { _tag: 'procedure', kind, input, output, requirements, handler }
}

/** Builder before an output schema is set — the terminal infers the output type from the handler. */
export class ProcedureBuilder<TContext, TInput> {
	constructor(
		private readonly _input: StandardSchemaV1<unknown, TInput>,
		private readonly _requirements: ReadonlyArray<AuthRequirement<TContext, TInput>>,
	) {}

	/** Set the input schema — ANY Standard Schema validator (zod, valibot, arktype, …). Resets requirements. */
	input<TNewInput>(schema: StandardSchemaV1<unknown, TNewInput>): ProcedureBuilder<TContext, TNewInput> {
		return new ProcedureBuilder<TContext, TNewInput>(schema, [])
	}

	/** Set an output schema → switch to the output builder (handler result validated against it). */
	output<TOutput>(schema: StandardSchemaV1<unknown, TOutput>): OutputProcedureBuilder<TContext, TInput, TOutput> {
		return new OutputProcedureBuilder<TContext, TInput, TOutput>(this._input, schema, this._requirements)
	}

	/**
	 * Record an authz requirement, checked BEFORE the handler runs (all must pass).
	 * Only available when the context carries `auth: AuthContext`.
	 */
	require<TThis extends { auth: AuthContext }>(
		this: ProcedureBuilder<TThis, TInput>,
		action: string,
		scopeResolver?: (input: TInput, ctx: TThis) => Scope | undefined,
	): ProcedureBuilder<TThis, TInput> {
		const requirement: AuthRequirement<TThis, TInput> = scopeResolver ? { action, scopeResolver } : { action }
		return new ProcedureBuilder<TThis, TInput>(this._input, [...this._requirements, requirement])
	}

	/** Terminal: a neutral handler (tagged `query`). Output type inferred from the return. */
	handler<TOutput>(fn: Handler<TContext, TInput, TOutput>): Procedure<TContext, TInput, TOutput> {
		return makeProcedure('query', this._input, null, this._requirements, fn)
	}

	/** Terminal: a `query`-tagged handler. Output type inferred from the return. */
	query<TOutput>(fn: Handler<TContext, TInput, TOutput>): Procedure<TContext, TInput, TOutput> {
		return makeProcedure('query', this._input, null, this._requirements, fn)
	}

	/** Terminal: a `mutation`-tagged handler. Output type inferred from the return. */
	mutation<TOutput>(fn: Handler<TContext, TInput, TOutput>): Procedure<TContext, TInput, TOutput> {
		return makeProcedure('mutation', this._input, null, this._requirements, fn)
	}
}

/** Builder after `.output(schema)` — the terminal fixes the output to the schema type + validates it. */
export class OutputProcedureBuilder<TContext, TInput, TOutput> {
	constructor(
		private readonly _input: StandardSchemaV1<unknown, TInput>,
		private readonly _output: StandardSchemaV1<unknown, TOutput>,
		private readonly _requirements: ReadonlyArray<AuthRequirement<TContext, TInput>>,
	) {}

	/** Record an authz requirement, checked BEFORE the handler runs (all must pass). */
	require<TThis extends { auth: AuthContext }>(
		this: OutputProcedureBuilder<TThis, TInput, TOutput>,
		action: string,
		scopeResolver?: (input: TInput, ctx: TThis) => Scope | undefined,
	): OutputProcedureBuilder<TThis, TInput, TOutput> {
		const requirement: AuthRequirement<TThis, TInput> = scopeResolver ? { action, scopeResolver } : { action }
		return new OutputProcedureBuilder<TThis, TInput, TOutput>(this._input, this._output, [...this._requirements, requirement])
	}

	/** Terminal: a neutral handler (tagged `query`); result validated against the output schema. */
	handler(fn: Handler<TContext, TInput, TOutput>): Procedure<TContext, TInput, TOutput> {
		return makeProcedure('query', this._input, this._output, this._requirements, fn)
	}

	/** Terminal: a `query`-tagged handler; result validated against the output schema. */
	query(fn: Handler<TContext, TInput, TOutput>): Procedure<TContext, TInput, TOutput> {
		return makeProcedure('query', this._input, this._output, this._requirements, fn)
	}

	/** Terminal: a `mutation`-tagged handler; result validated against the output schema. */
	mutation(fn: Handler<TContext, TInput, TOutput>): Procedure<TContext, TInput, TOutput> {
		return makeProcedure('mutation', this._input, this._output, this._requirements, fn)
	}
}

export function initRpc<TContext>(): {
	procedure: ProcedureBuilder<TContext, void>
	router<TDef extends RouterDef>(def: TDef): Router<TDef>
} {
	return {
		procedure: new ProcedureBuilder<TContext, void>(voidSchema, []),
		router<TDef extends RouterDef>(def: TDef): Router<TDef> {
			return { _tag: 'router', _def: def }
		},
	}
}
