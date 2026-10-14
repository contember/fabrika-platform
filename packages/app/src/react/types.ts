// The types the hooks read off a client procedure: its input as the caller writes it, and its answer as the output
// schema parses it.

import type { z } from 'zod/v4'
import type { Schema } from '../contract/define'

/** A query or mutation of a client that `createClient` built. */
export type ClientProcedure = ((input: never) => Promise<unknown>) & { readonly output: Schema }

/** A group of a client tree (`api.deals`), or the client itself: every procedure under it. */
export interface ClientGroup {
	readonly [name: string]: unknown
}

/** What `invalidate` takes: one procedure, or a group for every procedure under it. */
export type InvalidateTarget = ClientProcedure | ClientGroup

/** The input as the caller writes it; `undefined` admitted for a procedure that takes none. */
export type ProcedureInput<F extends ClientProcedure> = F extends (input: infer I) => Promise<unknown> ? I : never

/** A procedure by its input `I` and output schema `O`: what the hooks take, so both are inferred from the call. */
export type TypedProcedure<I, O extends Schema> = ((input: I) => Promise<unknown>) & { readonly output: O }

/** An input argument that may be left out when the procedure takes no input. */
export type InputArgument<I> = undefined extends I ? I | void : I

/** The answer, as the procedure's output schema parses it. */
export type ProcedureResult<F extends ClientProcedure> = z.output<F['output']>

/** The answer of a cursor list: `{ items, next }`. */
export interface PageAnswer<Item> {
	readonly items: readonly Item[]
	readonly next: string | null
}

/** A procedure that pages: input `after`, answer `{ items, next }`. */
export type PagedProcedure<I, Item> = ((input: I) => Promise<unknown>) & { readonly output: z.core.$ZodType<PageAnswer<Item>> }

/** The input of a paged procedure without its cursor: the hook sends `after` itself. */
export type PageInput<I> = undefined extends I ? Omit<NonNullable<I>, 'after'> | void : Omit<I, 'after'>
