// The builders a group, a link mount and an export hand their callback: each declares one endpoint and takes its
// handler with `.handle(fn)` beside it. `.handle` returns the declaration without the handler's type, so a contract
// of many endpoints stays cheap to type-check, and an endpoint without `.handle` is not a group member.

import type { RpcCaller } from '@fabrika/auth-core'
import type { Unavailable, UnscopedDeclaration, UnscopedMode } from '@fabrika/db/tables'
import type { z } from 'zod/v4'
import type { ExtraKeys, Handler, HandlerInput, IsAny } from '../implement/types'
import type { Declared, EndpointContext, ExportContext, ImportOf, KitTypes, LinkContext, SqlMode } from './context'
import type { ProcedureType } from './declaration'
import type { InputOf, InputSchema, LinkAccess, MemberAccess, MutationAccess, NotLoose, Procedure, QueryAccess, Schema } from './define'

/** Fields a builder sets itself: a definition that carries one does not type-check. */
type Owned<K extends string> = { readonly [P in K]?: never }

/** An endpoint's declaration: its schemas, its access form, and the off-road reach it declares. */
export interface EndpointDef<I, O, Acc, S, U, Cn, Is> extends Owned<'~kind' | 'type'> {
	readonly input?: I & NotLoose<I>
	readonly output: O & NotLoose<O>
	readonly access: Acc
	/** `ctx.sql`, in this mode; a query declares only `'read'`. */
	readonly sql?: S
	/** `ctx.db.unscoped.<table>`, each in its mode, scope predicate `true`; a query declares only `'read'`. */
	readonly unscoped?: U
	/** `ctx.connect.<connector>`, for the connectors the kit imports. */
	readonly connect?: Cn
	/** `ctx.links.issue` for this link mount, on an endpoint whose action is the mount's `issuedBy`. */
	readonly issues?: Is
}

type Returned<F> = F extends (args: never) => infer R ? Awaited<R> : never

/** The last member of a union, in the order the compiler holds it. */
type LastOf<U> = (U extends unknown ? (member: () => U) => void : never) extends (member: infer I) => void ? I extends () => infer L ? L : never
	: never

/** `'a' | 'b'` → `'a, b'`, for a message. */
type ListOf<U extends string, Listed extends string = ''> = [U] extends [never] ? Listed
	: ListOf<Exclude<U, LastOf<U>>, Listed extends '' ? LastOf<U> & string : `${LastOf<U> & string}, ${Listed}`>

/** The fields, at any depth, that a handler `F` returns and the output `O` does not declare. */
export type UndeclaredFields<F, O extends Schema> = ExtraKeys<Returned<F>, z.input<O>>

/**
 * What `.handle` answers: the endpoint, or — when the handler returns, at any depth, a field the output does not
 * declare — a message the group refuses at the endpoint's line. A field whose type is an error elsewhere in the
 * handler is not reported again here.
 */
export type ExactReturn<F, O extends Schema, E> = [UndeclaredFields<F, O>] extends [never] ? E
	: IsAny<UndeclaredFields<F, O>> extends true ? E
	: Unavailable<`the handler returns ${ListOf<UndeclaredFields<F, O> & string>}, which the output does not declare: return only declared fields`>

/** A declared, handled endpoint: what a group holds. Its type keeps the declaration and drops the handler's. */
export interface Endpoint<T extends ProcedureType, I extends InputSchema | null, O extends Schema, Acc, D> extends Procedure<T, I, O, Acc> {
	readonly declared: D
}

/** An endpoint before `.handle`: a group refuses it. */
export interface EndpointBuilder<T extends ProcedureType, I extends InputSchema | null, O extends Schema, Acc, D, Ctx> {
	/** The endpoint's handler, typed by its access form and declaration; it may return only the output's fields. */
	handle<const F extends Handler<HandlerInput<I, Acc>, Ctx, O>>(handler: F): ExactReturn<F, O, Endpoint<T, I, O, Acc, D>>
}

/** The builders of a group's callback: they know the group's callers, so a handler knows its principal. */
export interface GroupKit<K extends KitTypes, Caller extends RpcCaller> {
	query<
		const Acc extends QueryAccess<K['action'], K['dimension'], InputOf<I>>,
		O extends Schema,
		I extends InputSchema | null = null,
		const S extends 'read' = never,
		const U extends UnscopedDeclaration<K['tables'], 'read'> = never,
		const Cn extends readonly ImportOf<K>[] = never,
		const Is extends string = never,
	>(
		def: EndpointDef<I, O, Acc, S, U, Cn, Is>,
	): EndpointBuilder<'query', I, O, Acc, Declared<S, U, Cn, Is>, EndpointContext<K, Caller, 'query', Acc, Declared<S, U, Cn, Is>>>
	mutation<
		const Acc extends MutationAccess<K['action'], K['dimension'], K['creatable'], InputOf<I>>,
		O extends Schema,
		I extends InputSchema | null = null,
		const S extends SqlMode = never,
		const U extends UnscopedDeclaration<K['tables'], UnscopedMode> = never,
		const Cn extends readonly ImportOf<K>[] = never,
		const Is extends string = never,
	>(
		def: EndpointDef<I, O, Acc, S, U, Cn, Is>,
	): EndpointBuilder<'mutation', I, O, Acc, Declared<S, U, Cn, Is>, EndpointContext<K, Caller, 'mutation', Acc, Declared<S, U, Cn, Is>>>
}

/** Any handled endpoint. */
export type AnyEndpoint = Endpoint<ProcedureType, InputSchema | null, Schema, unknown, unknown>

/** What a group's callback returns: its endpoints by name. A mount nests groups; a group does not nest. */
export interface GroupTree {
	readonly [name: string]: AnyEndpoint
}

/** `app.group(…)`: endpoints for one set of callers, declared in any module and mounted by the contract. */
export interface Group<C extends readonly [RpcCaller, ...RpcCaller[]], T extends GroupTree> {
	readonly '~kind': 'group'
	readonly callers: C
	readonly endpoints: T
}

/** The builders of a link mount's callback: each procedure acts on the object its key is bound to. */
export interface LinkGroupKit<K extends KitTypes, LD extends string, G extends string> {
	query<
		const Acc extends LinkAccess<G>,
		O extends Schema,
		I extends InputSchema | null = null,
		const S extends 'read' = never,
		const U extends UnscopedDeclaration<K['tables'], 'read'> = never,
	>(
		def: EndpointDef<I, O, Acc, S, U, never, never>,
	): EndpointBuilder<'query', I, O, Acc, Declared<S, U, never, never>, LinkContext<K, 'query', LD, Acc['action'], Declared<S, U, never, never>>>
	mutation<
		const Acc extends LinkAccess<G>,
		O extends Schema,
		I extends InputSchema | null = null,
		const S extends SqlMode = never,
		const U extends UnscopedDeclaration<K['tables'], UnscopedMode> = never,
	>(
		def: EndpointDef<I, O, Acc, S, U, never, never>,
	): EndpointBuilder<'mutation', I, O, Acc, Declared<S, U, never, never>, LinkContext<K, 'mutation', LD, Acc['action'], Declared<S, U, never, never>>>
}

/** An export procedure names its action and its scope; `{ member: true }` would give the consumer's key nothing to hold. */
export type ExportAccess<A extends string, D extends string, In> = Exclude<QueryAccess<A, D, In>, MemberAccess>

/** The builder of an export's callback: queries only, run read-only. */
export interface ExportKit<K extends KitTypes> {
	query<
		const Acc extends ExportAccess<K['action'], K['dimension'], InputOf<I>>,
		O extends Schema,
		I extends InputSchema | null = null,
		const S extends 'read' = never,
		const U extends UnscopedDeclaration<K['tables'], 'read'> = never,
	>(
		def: EndpointDef<I, O, Acc, S, U, never, never>,
	): EndpointBuilder<'query', I, O, Acc, Declared<S, U, never, never>, ExportContext<K, Acc, Declared<S, U, never, never>>>
}
