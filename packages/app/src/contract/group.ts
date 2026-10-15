// The builders a group, a link mount and an export hand their callback: each declares one endpoint and takes its
// handler with `.handle(fn)` beside it. `.handle` returns the declaration without the handler's type, so a contract
// of many endpoints stays cheap to type-check, and an endpoint without `.handle` is not a group member.

import type { RpcCaller } from '@fabrika/auth-core'
import type { AnyDbIndex, ReadOnlyUnscoped, Unavailable, UnscopedDeclaration, UnscopedMode } from '@fabrika/db/tables'
import type { z } from 'zod/v4'
import type { Snake } from '../from-row'
import type { ExtraKeys, HandlerInput, IsAny } from '../implement/types'
import type { AttachmentBrand } from './attachment'
import type { CheckedAccess, Declared, EndpointContext, ExportContext, ImportOf, KitTypes, LinkContext, SqlMode } from './context'
import type { ProcedureType } from './declaration'
import type { AppAccess, InputOf, InputSchema, LinkAccess, MemberAccess, MutationAccess, NotLoose, Procedure, QueryAccess, Schema } from './define'

/** Fields a builder sets itself: a definition that carries one does not type-check. */
type Owned<K extends string> = { readonly [P in K]?: never }

/** Unknown keys of an `unscoped` declaration, each refused at its own line. */
type ExactTables<U, Tables extends string> = [Exclude<keyof U, Tables>] extends [never] ? unknown
	: { readonly [P in Exclude<keyof U, Tables>]: Unavailable<`${P & string} is not a table of src/db/tables.ts`> }

/**
 * The off-road fields a site declares. Each is inferred from its optional field and then required: a handle exists
 * only for a declaration the object really carries, never for one an annotation merely allows.
 */
export type DeclaredFields<S, U, Cn, Is, Ix extends AnyDbIndex> =
	& {
		/** `ctx.sql`, in this mode; a query declares only `'read'`. */
		readonly sql?: S
		/** `ctx.db.unscoped.<table>`, each in its mode, scope predicate `true`; a query declares only `'read'`. */
		readonly unscoped?: U
		/** `ctx.connect.<connector>`, for the connectors the kit imports. */
		readonly connect?: Cn
		/** `ctx.links.issue` for this link mount, on an endpoint whose action is the mount's `issuedBy`. */
		readonly issues?: Is
	}
	& ([S] extends [never] ? unknown : { readonly sql: S & NoInfer<SqlReach<keyof Ix['tables'] & string>> })
	& ([U] extends [never] ? unknown : { readonly unscoped: U & NoInfer<ExactTables<U, keyof Ix['tables'] & string> & ReadOnlyUnscoped<Ix, U>> })
	& ([Cn] extends [never] ? unknown : { readonly connect: Cn & NoInfer<LiteralList<Cn>> })
	& ([Is] extends [never] ? unknown : { readonly issues: Is & NoInfer<OneLiteral<Is>> })

/** `ctx.sql` runs on `@fabrika/db`, so a kit without tables declares no `sql`. */
type SqlReach<Tables extends string> = [Tables] extends [never]
	? Unavailable<'ctx.sql runs on @fabrika/db: a kit without tables (defineApp(vocabulary)) declares no sql'>
	: unknown

/** A list typed only by its element (`readonly 'catalog'[]`) may hold none of them; the declaration is a literal tuple. */
type LiteralList<Cn> = Cn extends readonly unknown[]
	? number extends Cn['length'] ? "connect names its connectors as a literal list: connect: ['catalog']"
	: unknown
	: unknown

/** `issues` names one link mount, as a literal. */
type OneLiteral<Is> = string extends Is ? Unavailable<"issues names one link mount, as a literal: issues: 'shared'">
	: true extends IsUnion<Is> ? Unavailable<"issues names one link mount, as a literal: issues: 'shared'">
	: unknown

/** `then` names one cron job, as a literal. */
type OneJob<Th> = string extends Th ? Unavailable<"then names one cron job, as a literal: then: 'mailing'">
	: true extends IsUnion<Th> ? Unavailable<"then names one cron job, as a literal: then: 'mailing'">
	: unknown

/** A mutation's `then`, inferred from its optional field and then required, like a declared field. */
type KickField<Th> =
	& {
		/** The cron job this mutation kicks once its transaction committed; the schedule stays its recovery. */
		readonly then?: Th
	}
	& ([Th] extends [never] ? unknown : { readonly then: Th & NoInfer<OneJob<Th>> })

/** A query writes nothing, so it has nothing to kick a job for. */
type NoKick = { readonly then?: Unavailable<'a query kicks no job: declare then on a mutation'> }

type IsUnion<T, All = T> = T extends unknown ? ([All] extends [T] ? false : true) : never

/** An endpoint's declaration: its schemas, its access form and the reach it declares. */
export type EndpointDef<I, O, Acc, S, U, Cn, Is, Ix extends AnyDbIndex> =
	& Owned<'~kind' | 'type'>
	& {
		readonly input?: I & NotLoose<I>
		readonly output: O & NotLoose<O>
		readonly access: Acc
	}
	& DeclaredFields<S, U, Cn, Is, Ix>

type Returned<F> = F extends (args: never) => infer R ? Awaited<R> : never

/** The last member of a union, in the order the compiler holds it. */
type LastOf<U> = (U extends unknown ? (member: () => U) => void : never) extends (member: infer I) => void ? I extends () => infer L ? L : never
	: never

/** `'a' | 'b'` → `'a, b'`, for a message. */
export type ListOf<U extends string, Listed extends string = ''> = [U] extends [never] ? Listed
	: ListOf<Exclude<U, LastOf<U>>, Listed extends '' ? LastOf<U> & string : `${LastOf<U> & string}, ${Listed}`>

/** The fields, at any depth, that a handler `F` returns and the output `O` does not declare. */
export type UndeclaredFields<F, O extends Schema> = ExtraKeys<Returned<F>, z.input<O>>

/** An object with a camelCase field, which a database row names in snake_case. */
type HasCamel<V> = { [K in keyof V]: K extends string ? (Snake<K> extends K ? never : K) : never }[keyof V]

/**
 * A database row returned where the output declares camelCase fields: its snake_case columns, of any value, at the
 * depth the output has them. `.handle` admits it so that `ExactReturn` can name `fromRow` in one line.
 */
type RowShaped<V> = V extends readonly (infer Item)[] ? readonly RowShaped<Item>[]
	: V extends object
		? [HasCamel<V>] extends [never] ? { readonly [K in keyof V]: RowShaped<V[K]> } : { readonly [K in keyof V as Snake<K & string>]: unknown }
	: V

/**
 * What a kit handler `F` may return: the output, or — only when `F` returns one — a database row of it, which
 * `ExactReturn` refuses with the fix, as it refuses anything but rows from an attachment's handler. Any other mistake
 * keeps the compiler's own message about the output.
 */
export type HandlerReturn<F, O extends Schema> = [Returned<F>] extends [z.input<O>] ? z.input<O>
	: [O] extends [AttachmentBrand] ? unknown
	: [Returned<F>] extends [RowShaped<z.input<O>>] ? RowShaped<z.input<O>>
	: z.input<O>

/** A kit endpoint's handler, returning `R`. */
export type KitHandler<In, Ctx, R> = (args: { readonly input: In; readonly ctx: Ctx }) => R | Promise<R>

/**
 * What `.handle` answers: the endpoint, or a message the group refuses at the endpoint's line — when the handler
 * returns a database row where the output is camelCase, anything but rows for an attachment, or, at any depth, a
 * field the output does not declare. A field whose type is an error elsewhere in the handler is not reported again here.
 */
export type ExactReturn<F, O extends Schema, E> = [Returned<F>] extends [z.input<O>] ? [UndeclaredFields<F, O>] extends [never] ? E
	: IsAny<UndeclaredFields<F, O>> extends true ? E
	: Unavailable<`the handler returns ${ListOf<UndeclaredFields<F, O> & string>}, which the output does not declare: return only declared fields`>
	: [O] extends [AttachmentBrand] ? Unavailable<'an attachment handler returns its rows: an array of its row schema, with nothing around it'>
	: Unavailable<
		`the handler returns a database row (${ListOf<
			UndeclaredFields<F, O> & string
		>}) where the output is camelCase: map it with fromRow(Schema, row) from @fabrika/app`
	>

/** A declared, handled endpoint: what a group holds. Its type keeps the declaration and drops the handler's. */
export interface Endpoint<T extends ProcedureType, I extends InputSchema | null, O extends Schema, Acc, D> extends Procedure<T, I, O, Acc> {
	readonly declared: D
}

/** An endpoint before `.handle`: a group refuses it. */
export interface EndpointBuilder<T extends ProcedureType, I extends InputSchema | null, O extends Schema, Acc, D, Ctx> extends PendingEndpoint {
	/** The endpoint's handler, typed by its access form and declaration; it may return only the output's fields. */
	handle<const F extends KitHandler<HandlerInput<I, Acc>, Ctx, HandlerReturn<F, O>>>(handler: F): ExactReturn<F, O, Endpoint<T, I, O, Acc, D>>
}

/** What every endpoint builder has and no handled endpoint has. */
export interface PendingEndpoint {
	handle(handler: never): unknown
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
		def: EndpointDef<I, O, Acc, S, U, Cn, Is, K['index']> & NoKick,
	): EndpointBuilder<
		'query',
		I,
		O,
		Acc,
		Declared<S, U, Cn, Is>,
		EndpointContext<K, Caller, 'query', CheckedAccess<Acc>, Declared<S, U, Cn, Is>>
	>
	mutation<
		const Acc extends MutationAccess<K['action'], K['dimension'], K['creatable'], InputOf<I>>,
		O extends Schema,
		I extends InputSchema | null = null,
		const S extends SqlMode = never,
		const U extends UnscopedDeclaration<K['tables'], UnscopedMode> = never,
		const Cn extends readonly ImportOf<K>[] = never,
		const Is extends string = never,
		const Th extends string = never,
	>(
		def: EndpointDef<I, O, Acc, S, U, Cn, Is, K['index']> & KickField<Th>,
	): EndpointBuilder<
		'mutation',
		I,
		O,
		Acc,
		Declared<S, U, Cn, Is>,
		EndpointContext<K, Caller, 'mutation', CheckedAccess<Acc>, Declared<S, U, Cn, Is>>
	>
}

/** Any handled endpoint. */
export type AnyEndpoint = Endpoint<ProcedureType, InputSchema | null, Schema, unknown, unknown>

/** What a group's callback returns: its endpoints by name. A mount nests groups; a group does not nest. */
export interface GroupTree {
	readonly [name: string]: AnyEndpoint
}

/** What a group's callback may return before the group checks that every endpoint took its handler. */
export interface GroupInput {
	readonly [name: string]: AnyEndpoint | PendingEndpoint
}

declare const failedBuild: unique symbol

/**
 * The constraint `app.group` infers against. A refused callback falls back to it, and its private symbol keeps the
 * mount from repeating that error. It is not an annotation: a group typed with it mounts unchecked.
 */
export interface GroupBuild extends GroupInput {
	readonly [failedBuild]?: true
}

/**
 * A builder without `.handle(…)`. An endpoint typed by the compiler's error type is the consequence of a type error
 * inside its handler, reported there; every check is wrapped in a tuple, since an unwrapped one answers the error type.
 */
type IsPending<E> = [0] extends [1 & E] ? false : [Extract<E, PendingEndpoint>] extends [never] ? false : true

/** The endpoints of a group, prefixed by `Path`, that have no `.handle(…)`. */
export type PendingIn<T, Path extends string> = typeof failedBuild extends keyof T ? never
	: string extends keyof T ? [IsPending<T[string & keyof T]>] extends [true] ? `${Path}* (its type admits an endpoint without a handler)` : never
	: { [K in keyof T]: [IsPending<T[K]>] extends [true] ? `${Path}${K & string}` : never }[keyof T]

/** `app.group(…)`: endpoints for one set of callers, declared in any module and mounted by the contract. */
export interface Group<C extends readonly [RpcCaller, ...RpcCaller[]], T extends GroupInput> {
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
		def: EndpointDef<I, O, Acc, S, U, never, never, K['index']> & NoKick,
	): EndpointBuilder<'query', I, O, Acc, Declared<S, U, never, never>, LinkContext<K, 'query', LD, Acc['action'], Declared<S, U, never, never>>>
	mutation<
		const Acc extends LinkAccess<G>,
		O extends Schema,
		I extends InputSchema | null = null,
		const S extends SqlMode = never,
		const U extends UnscopedDeclaration<K['tables'], UnscopedMode> = never,
		const Th extends string = never,
	>(
		def: EndpointDef<I, O, Acc, S, U, never, never, K['index']> & KickField<Th>,
	): EndpointBuilder<'mutation', I, O, Acc, Declared<S, U, never, never>, LinkContext<K, 'mutation', LD, Acc['action'], Declared<S, U, never, never>>>
}

/** An export procedure names its action and its scope; `{ member: true }` would give the consumer's key nothing to hold. */
export type ExportAccess<A extends string, D extends string, In> = Exclude<QueryAccess<A, D, In>, MemberAccess | AppAccess<A>>

/** The builder of an export's callback: queries only, run read-only. */
export interface ExportKit<K extends KitTypes> {
	query<
		const Acc extends ExportAccess<K['action'], K['dimension'], InputOf<I>>,
		O extends Schema,
		I extends InputSchema | null = null,
		const S extends 'read' = never,
		const U extends UnscopedDeclaration<K['tables'], 'read'> = never,
	>(
		def: EndpointDef<I, O, Acc, S, U, never, never, K['index']>,
	): EndpointBuilder<
		'query',
		I,
		O,
		Acc,
		Declared<S, U, never, never>,
		ExportContext<K, CheckedAccess<Acc>, Declared<S, U, never, never>>
	>
}
