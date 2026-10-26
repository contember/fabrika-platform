// The builders a group, a link mount and an export hand their callback: each declares one endpoint and takes its
// handler with `.handle(fn)` beside it. `.handle` returns the declaration without the handler's type, so a contract
// of many endpoints stays cheap to type-check, and an endpoint without `.handle` is not a group member.

import type { EndpointCache, RpcCaller } from '@fabrika/auth-core'
import type { AnyDbIndex, ReadOnlyUnscoped, Unavailable, UnscopedDeclaration, UnscopedMode } from '@fabrika/db/tables'
import type { z } from 'zod/v4'
import type { Snake } from '../from-row'
import type { ExtraKeys, HandlerInput, IsAny } from '../implement/types'
import type { AttachmentBrand } from './attachment'
import type {
	CheckedAccess,
	Declared,
	EndpointContext,
	ExportContext,
	ImportOf,
	KickContext,
	KitTypes,
	LinkContext,
	PublicContext,
	SqlMode,
	TokensContext,
	WebhooksContext,
} from './context'
import type { ProcedureType } from './declaration'
import type {
	AppAccess,
	CapabilitiesAccess,
	CapabilityAccess,
	ChallengeOption,
	InputOf,
	InputSchema,
	LinkAccess,
	MemberAccess,
	MutationAccess,
	NotLoose,
	Procedure,
	PublicAccess,
	QueryAccess,
	Schema,
} from './define'
import type { WithClaims } from './token'

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

/** A query writes nothing, so it has nothing to kick a job for and no binding to write. */
type NoKick = {
	readonly kicks?: Unavailable<'a query kicks no job: declare kicks on a mutation'>
	readonly binds?: Unavailable<'a query binds no webhook: declare binds on a mutation'>
}

/** `binds` names one webhook, as a literal. */
type OneWebhook<Bs> = string extends Bs ? Unavailable<"binds names one webhook, as a literal: binds: 'stripe'">
	: true extends IsUnion<Bs> ? Unavailable<"binds names one webhook, as a literal: binds: 'stripe'">
	: unknown

/** The webhook whose bindings a mutation writes (`ctx.webhooks`), inferred from its optional field and then required. */
type BindsField<Bs> =
	& { readonly binds?: Bs }
	& ([Bs] extends [never] ? unknown : { readonly binds: Bs & NoInfer<OneWebhook<Bs>> })

/** The jobs a mutation may kick (`ctx.kick`), inferred from its optional field and then required, as a literal list. */
export type KicksField<Ks> =
	& { readonly kicks?: Ks }
	& ([Ks] extends [never] ? unknown : { readonly kicks: Ks & NoInfer<LiteralList<Ks>> })

/** The token purposes a site signs (`ctx.tokens.sign`), inferred from its optional field and then required, as a literal list. */
export type SignsField<Sg, Purposes extends string> =
	& { readonly signs?: Sg }
	& ([Sg] extends [never] ? unknown : { readonly signs: Sg & NoInfer<KnownPurposes<Sg, Purposes>> })

/**
 * The HTTPS origins a site's code calls (`fetch`): each an exact origin, no path or wildcard. A guard on the global
 * `fetch` refuses any other while the site runs; a public procedure declares none.
 */
export interface EgressField {
	readonly egress?: readonly `https://${string}`[] | Unavailable<"egress: 'public' is a cron job's only: record a row and kick a job that declares it">
}

/**
 * A cron job's `egress`: its exact HTTPS origins, or `'public'`, every public host over HTTPS or HTTP on its default
 * port, for a job that calls the websites its operators name (ADR-0071). The guard refuses IP addresses, local and
 * internal names and the installation's own hosts, checks each redirect, and bounds each request's time and body.
 */
export interface JobEgressField {
	readonly egress?: readonly `https://${string}`[] | 'public'
}

/** Each purpose `signs` names is one of `defineApp`'s `tokens`. */
type KnownPurposes<Sg, Purposes extends string> = Sg extends readonly (infer P extends string)[]
	? [Exclude<P, Purposes>] extends [never] ? LiteralList<Sg>
	: Unavailable<`signs names ${ListOf<Exclude<P, Purposes>>}, which defineApp's tokens do not declare`>
	: unknown

type IsUnion<T, All = T> = T extends unknown ? ([All] extends [T] ? false : true) : never

/** A bucket's calls per minute, or `null` to turn a default bucket off. */
type Bucket = number | null

/**
 * How a procedure is admitted (`admission`), merged into its kind's default: a public mutation counts 10 calls per
 * minute per client and 100 for the endpoint; every other procedure counts none unless it declares a bucket.
 */
export type AdmissionOption<Acc> = [Acc] extends [PublicAccess] ? {
		/** `'same-origin'` by default; `'listed'` the environment's listed origins; `'any'` every origin. */
		readonly origins?: 'same-origin' | 'listed' | 'any'
		readonly rate?: { readonly perClient?: Bucket; readonly perEndpoint?: Bucket; readonly bytesPerHour?: Bucket }
		/** Verified on the server before the handler; the input carries the widget's token in `challengeToken`. */
		readonly challenge?: ChallengeOption
	}
	: {
		/** `'same-origin'` by default; `'listed'` the environment's listed origins, with a key only (ADR-0022). */
		readonly origins?: 'same-origin' | 'listed'
		readonly rate?: { readonly perCaller?: Bucket; readonly perEndpoint?: Bucket }
	}

/** A procedure's bounds: its body in bytes (64 KiB by default, at most 1 MiB) and its handler's time (10 s, at most 60 s). */
export interface LimitsOption {
	readonly maxBytes?: number
	readonly timeoutMs?: number
}

/**
 * A public procedure's workload actions, which its handler holds and nothing else; no other procedure declares them.
 * Inferred from the optional field and then required, like a declared field.
 */
export type PublicFields<Acc, Acts> = [Acc] extends [PublicAccess] ? {
		readonly actions:
			& Acts
			& NoInfer<Acts extends readonly [] ? Unavailable<"a public procedure names what its handler holds: actions: ['<action>']"> : unknown>
	}
	: { readonly actions?: Unavailable<'only a public procedure declares actions: its handler runs as its own workload'> }

/** The handler context of a group's procedure: a public one runs as its own workload, every other as its caller. */
export type ProcedureContext<
	K extends KitTypes,
	Caller extends RpcCaller,
	Kind extends 'query' | 'mutation',
	Acc,
	Acts extends readonly string[],
	D extends Declared<SqlMode, unknown, readonly string[], string>,
	Ks = never,
	Bs = never,
	Sg = never,
> =
	& ([Acc] extends [PublicAccess] ? PublicContext<K, Kind, Acts[number]>
		: EndpointContext<K, Caller, Kind, CheckedAccess<Acc>, D> & WebhooksContext<Bs>)
	& KickContext<Ks>
	& TokensContext<K, Sg>

/** A group without callers holds public procedures only; any other group may hold both. */
export type GroupAccess<Caller extends RpcCaller, Acc> = [Caller] extends [never] ? PublicAccess : Acc | PublicAccess

/** An endpoint's declaration: its schemas, its access form and the reach it declares. */
export type EndpointDef<I, O, Acc, S, U, Cn, Is, Ix extends AnyDbIndex> =
	& Owned<'~kind' | 'type'>
	& {
		readonly input?: I & NotLoose<I>
		readonly output: O & NotLoose<O>
		readonly access: Acc
		readonly admission?: AdmissionOption<Acc>
		readonly limits?: LimitsOption
	}
	& DeclaredFields<S, U, Cn, Is, Ix>

/**
 * A group procedure's HTTP shape, its `query` schema inferred: what its handler then reads as `query`. Only a public
 * procedure has a path of its own.
 */
type HttpField<Q, Acc> = { readonly http?: HttpOption<Q & NoInfer<NotLoose<Q>>> & OwnPathOption<Acc> }

/**
 * `http.path`: a public procedure served at a literal path of its own instead of `<prefix>/<name>`, so a caller outside
 * the application keeps its URL. It lies outside every mount's prefix and under no `/__fabrika`.
 */
export type OwnPathOption<Acc> = [Acc] extends [PublicAccess] ? { readonly path?: `/${string}` } : unknown

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

/** A kit endpoint's handler, returning `R`; `X` adds what its HTTP shape reads beside the input (`query`). */
export type KitHandler<In, Ctx, R, X = unknown> = (args: { readonly input: In; readonly ctx: Ctx } & X) => R | Promise<R>

/**
 * What a handler reads beside its input: the URL's `query` of a POST that declares `http.query`, each signed token in it
 * as the claims of its purpose.
 */
export type QueryArgs<Q, T = Record<never, never>> = [Q] extends [never] ? unknown
	: Q extends InputSchema ? { readonly query: WithClaims<z.output<Q>, T> }
	: unknown

/**
 * The wire of a procedure: `POST` with a JSON body by default; a query may be `GET`, its input then flat scalar URL
 * parameters; a POST may read a flat `query` from the URL and take a native form's `urlencoded` body.
 */
export interface HttpOption<Q> {
	readonly method?: 'GET' | 'POST'
	readonly query?: Q
	readonly body?: 'json' | 'urlencoded'
	/**
	 * A public GET query's successful answers may be reused: `{ maxAgeSeconds }`, or `'immutable'` (a year) when its
	 * input names an immutable value. Every other answer is `no-store`.
	 */
	readonly cache?: EndpointCache
}

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

/**
 * An endpoint before `.handle`: a group refuses it. `Tk` are the kit's token purposes: a signed token field of the input
 * reaches the handler as the claims of its purpose.
 */
export interface EndpointBuilder<
	T extends ProcedureType,
	I extends InputSchema | null,
	O extends Schema,
	Acc,
	D,
	Ctx,
	X = unknown,
	Tk = Record<never, never>,
> extends PendingEndpoint {
	/** The endpoint's handler, typed by its access form and declaration; it may return only the output's fields. */
	handle<const F extends KitHandler<WithClaims<HandlerInput<I, Acc>, Tk>, Ctx, HandlerReturn<F, O>, X>>(
		handler: F,
	): ExactReturn<F, O, Endpoint<T, I, O, Acc, D>>
}

/** What every endpoint builder has and no handled endpoint has. */
export interface PendingEndpoint {
	handle(handler: never): unknown
}

/**
 * The builders of a group's callback: they know the group's callers, so a handler knows its principal. A group without
 * callers (`Caller` is `never`) declares public procedures only.
 */
export interface GroupKit<K extends KitTypes, Caller extends RpcCaller> {
	query<
		const Acc extends GroupAccess<Caller, QueryAccess<K['action'], K['dimension'], InputOf<I>>>,
		O extends Schema,
		I extends InputSchema | null = null,
		const S extends 'read' = never,
		const U extends UnscopedDeclaration<K['tables'], 'read'> = never,
		const Cn extends readonly ImportOf<K>[] = never,
		const Is extends string = never,
		const Acts extends readonly K['action'][] = never,
		Q extends InputSchema = never,
		const Sg extends readonly string[] = never,
	>(
		def:
			& EndpointDef<I, O, Acc, S, U, Cn, Is, K['index']>
			& PublicFields<Acc, Acts>
			& HttpField<Q, Acc>
			& NoKick
			& SignsField<Sg, keyof K['tokens'] & string>
			& EgressField,
	): EndpointBuilder<
		'query',
		I,
		O,
		Acc,
		Declared<S, U, Cn, Is>,
		ProcedureContext<K, Caller, 'query', Acc, Acts, Declared<S, U, Cn, Is>, never, never, Sg>,
		QueryArgs<Q, K['tokens']>,
		K['tokens']
	>
	mutation<
		const Acc extends GroupAccess<Caller, MutationAccess<K['action'], K['dimension'], K['creatable'], InputOf<I>>>,
		O extends Schema,
		I extends InputSchema | null = null,
		const S extends SqlMode = never,
		const U extends UnscopedDeclaration<K['tables'], UnscopedMode> = never,
		const Cn extends readonly ImportOf<K>[] = never,
		const Is extends string = never,
		const Acts extends readonly K['action'][] = never,
		Q extends InputSchema = never,
		const Ks extends readonly string[] = never,
		const Bs extends string = never,
		const Sg extends readonly string[] = never,
	>(
		def:
			& EndpointDef<I, O, Acc, S, U, Cn, Is, K['index']>
			& PublicFields<Acc, Acts>
			& HttpField<Q, Acc>
			& KicksField<Ks>
			& BindsField<Bs>
			& SignsField<Sg, keyof K['tokens'] & string>
			& EgressField,
	): EndpointBuilder<
		'mutation',
		I,
		O,
		Acc,
		Declared<S, U, Cn, Is>,
		ProcedureContext<K, Caller, 'mutation', Acc, Acts, Declared<S, U, Cn, Is>, Ks, Bs, Sg>,
		QueryArgs<Q, K['tokens']>,
		K['tokens']
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

/** `app.group(…)`: endpoints for one set of callers (none for a group of public procedures), mounted by the contract. */
export interface Group<C extends readonly RpcCaller[], T extends GroupInput> {
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
	): EndpointBuilder<
		'query',
		I,
		O,
		Acc,
		Declared<S, U, never, never>,
		LinkContext<K, 'query', LD, Acc['action'], Declared<S, U, never, never>>,
		unknown,
		K['tokens']
	>
	mutation<
		const Acc extends LinkAccess<G>,
		O extends Schema,
		I extends InputSchema | null = null,
		const S extends SqlMode = never,
		const U extends UnscopedDeclaration<K['tables'], UnscopedMode> = never,
		const Ks extends readonly string[] = never,
	>(
		def: EndpointDef<I, O, Acc, S, U, never, never, K['index']> & KicksField<Ks>,
	): EndpointBuilder<
		'mutation',
		I,
		O,
		Acc,
		Declared<S, U, never, never>,
		LinkContext<K, 'mutation', LD, Acc['action'], Declared<S, U, never, never>> & KickContext<Ks>,
		unknown,
		K['tokens']
	>
}

/** An export procedure names its action and its scope; `{ member: true }` would give the consumer's key nothing to hold. */
export type ExportAccess<A extends string, D extends string, In> = Exclude<
	QueryAccess<A, D, In>,
	MemberAccess | AppAccess<A> | CapabilitiesAccess<{ readonly [name: string]: CapabilityAccess<A, D, In> }>
>

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
