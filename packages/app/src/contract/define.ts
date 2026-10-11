// `defineContract`: the application's whole access surface as data. Browser-safe: it builds plain objects and
// holds zod schemas; it validates nothing at runtime, `compileContract` does.

import type { RpcCaller } from '@fabrika/auth-core'
import type { z } from 'zod/v4'
import {
	type CronDeclaration,
	type CspDeclaration,
	type ExportAccessDeclaration,
	type ExportDeclaration,
	type FilesDeclaration,
	type FormMountDeclaration,
	type HealthMountDeclaration,
	type ImportDeclaration,
	type LinkAccessDeclaration,
	type LinkMountDeclaration,
	type ProcedureDeclaration,
	type ProcedureTreeDeclaration,
	type ProcedureType,
	type RpcMountDeclaration,
	type SpaAccessDeclaration,
	type SpaMountDeclaration,
	unknownOptions,
	type WebhookMountDeclaration,
} from './declaration'

export type Path = `/${string}`

/** Any zod 4 schema. `compileContract` refuses every form outside the contract subset. */
export type Schema = z.core.$ZodType

/**
 * An input object. zod 4's types do not tell `z.object` from `z.strictObject`, so the type refuses only loose
 * objects; `compileContract` and `@fabrika/check` refuse `z.object` too.
 */
export type InputSchema = z.ZodObject<z.core.$ZodShape, z.core.$ZodObjectConfig>

type LooseMessage = 'a loose object admits undeclared keys: declare it with z.strictObject({ … })'

/** `S`, unless it is an object that admits undeclared keys (`.loose()`, `.passthrough()`, `.catchall()`). */
export type NotLoose<S> = S extends z.ZodObject<z.core.$ZodShape, infer Config extends z.core.$ZodObjectConfig>
	? string extends keyof Config['out'] ? LooseMessage : S
	: S

/** Fields a builder sets itself: an options object that carries one does not type-check. */
type Owned<K extends string> = { readonly [P in K]?: never }

export type WildcardMessage = 'an action is exact: a role grants listed actions, and * is not an action'

// ── Vocabulary ──────────────────────────────────────────────────────────────────────────────────

export interface DimensionDef<A extends string, D extends string, R extends string> {
	/** Containment: every value of this dimension lies in exactly one value of `in`. */
	readonly in?: D
	/** `creates: <dimension>` mints a value and grants the caller this role in it. */
	readonly creator?: R
	/** The action that manages the dimension's members, and the one that lists them. */
	readonly members?: { readonly manage: A; readonly list: A }
}

export interface RoleDef<A extends string, D extends string, R extends string> {
	/** Exact actions only: `'*'` and `'notes.*'` are not actions of this contract. */
	readonly grants: readonly A[]
	/** A membership role, granted in one value of `scope` by a holder of an `assignableBy` role there. */
	readonly member?: { readonly scope: D; readonly assignableBy: readonly R[] }
}

export interface Vocabulary<A extends string, D extends string, R extends string> {
	readonly app: string
	readonly dimensions: { readonly [K in D]: DimensionDef<A, D, R> }
	readonly actions: { readonly [K in A]: string }
	readonly roles: { readonly [K in R]: RoleDef<A, D, R> }
}

/**
 * Top-level dimensions that declare a `creator` role; only they can be the target of `creates`. IAM creates a value
 * with no container (`createScope`); a contained value is a row its container's members insert.
 */
export type CreatableDimension<Dims> =
	& {
		[K in keyof Dims]: Dims[K] extends { readonly creator: string } ? Dims[K] extends { readonly in: string } ? never : K : never
	}[keyof Dims]
	& string

// ── Access requirements ─────────────────────────────────────────────────────────────────────────

export interface MemberAccess {
	readonly member: true
}
export interface OverAccess<A extends string, D extends string> {
	readonly action: A
	readonly over: D
}
export interface InAccess<A extends string, D extends string, F extends string> {
	readonly action: A
	readonly in: D
	readonly from: F
}
export interface OnAccess<A extends string, D extends string, F extends string> {
	readonly action: A
	readonly on: D
	readonly from: F
}
export interface CreatesAccess<A extends string, D extends string> {
	readonly action: A
	readonly creates: D
}
export interface LinkAccess<A extends string> {
	readonly action: A
}

/** Without an `input`, TS infers `I` as its whole constraint, not the `null` default; both mean "no input". */
export type InputOf<I> = [I] extends [InputSchema] ? z.output<I> : Record<never, never>

/** Input fields of string type: the only fields a scope value can be read from. */
export type StringField<In> = { [K in keyof In]-?: In[K] extends string ? K : never }[keyof In] & string

export type QueryAccess<A extends string, D extends string, In> =
	| MemberAccess
	| OverAccess<A, D>
	| InAccess<A, D, StringField<In>>
	| OnAccess<A, D, StringField<In>>

export type MutationAccess<A extends string, D extends string, CD extends string, In> = QueryAccess<A, D, In> | CreatesAccess<A, CD>

// ── Endpoints and mounts ────────────────────────────────────────────────────────────────────────

export interface Procedure<T extends ProcedureType, I extends InputSchema | null, O extends Schema, Acc> extends ProcedureDeclaration<Schema, Acc> {
	readonly type: T
	readonly input: I | null
	readonly output: O
}

export type ProcedureTree = ProcedureTreeDeclaration<Schema>

export type LinkProcedureTree = ProcedureTreeDeclaration<Schema, LinkAccessDeclaration>

/** Exports serve queries only: a read-only context, so retrying one is safe. */
export interface QueryTree {
	readonly [name: string]: (ProcedureDeclaration<Schema, ExportAccessDeclaration> & { readonly type: 'query' }) | QueryTree
}

export interface ProcedureDef<I, O, Acc> extends Owned<'~kind' | 'type'> {
	readonly input?: I & NotLoose<I>
	readonly output: O & NotLoose<O>
	readonly access: Acc
}

export interface RpcMount<C extends readonly [RpcCaller, ...RpcCaller[]], T extends ProcedureTree> extends RpcMountDeclaration<Schema> {
	readonly callers: C
	readonly procedures: T
}

export interface LinkMount<D extends string, G extends string, IB extends string, T extends LinkProcedureTree> extends LinkMountDeclaration<Schema> {
	readonly dimension: D
	readonly grants: readonly G[]
	readonly issuedBy: IB
	readonly procedures: T
}

export interface SpaMount<Acc extends SpaAccessDeclaration> extends SpaMountDeclaration {
	readonly access: Acc
}

export type HealthMount = HealthMountDeclaration

export interface FormMount<I extends Schema> extends FormMountDeclaration<Schema> {
	readonly input: I
}

export interface WebhookMount<B extends string, Acts extends string, I extends Schema> extends WebhookMountDeclaration<Schema> {
	readonly boundTo: B
	readonly actions: readonly Acts[]
	readonly input: I
}

export interface FileCollection<A extends string> extends FilesDeclaration {
	readonly read: A
	readonly write: A
	readonly delete: A
}

export interface CronJob<Acts extends string, Sc extends string> extends CronDeclaration {
	readonly actions: readonly Acts[]
	readonly scope: Sc
}

export interface Export<T extends QueryTree> extends ExportDeclaration<Schema> {
	readonly procedures: T
}

export type AnyMount =
	| RpcMount<readonly [RpcCaller, ...RpcCaller[]], ProcedureTree>
	| LinkMount<string, string, string, LinkProcedureTree>
	| SpaMount<SpaAccessDeclaration>
	| HealthMount
	| FormMount<Schema>
	| WebhookMount<string, string, Schema>

/** What the callback of `defineContract` returns: mounts by name, and the sections `SURFACE_SECTIONS` names. */
export interface SurfaceSections {
	readonly files?: { readonly [name: string]: FileCollection<string> }
	readonly jobs?: { readonly [name: string]: CronJob<string, string> }
	readonly exports?: { readonly [name: string]: Export<QueryTree> }
	readonly imports?: { readonly [name: string]: ImportDeclaration }
	readonly csp?: CspDeclaration
}

export interface Surface extends SurfaceSections {
	readonly [name: string]: AnyMount | SurfaceSections[keyof SurfaceSections]
}

export interface LinkKit<A extends string> {
	query<const Acc extends LinkAccess<A>, O extends Schema, I extends InputSchema | null = null>(
		def: ProcedureDef<I, O, Acc>,
	): Procedure<'query', I, O, Acc>
	mutation<const Acc extends LinkAccess<A>, O extends Schema, I extends InputSchema | null = null>(
		def: ProcedureDef<I, O, Acc>,
	): Procedure<'mutation', I, O, Acc>
}

export interface Kit<A extends string, D extends string, CD extends string> {
	query<const Acc extends QueryAccess<A, D, InputOf<I>>, O extends Schema, I extends InputSchema | null = null>(
		def: ProcedureDef<I, O, Acc>,
	): Procedure<'query', I, O, Acc>
	mutation<const Acc extends MutationAccess<A, D, CD, InputOf<I>>, O extends Schema, I extends InputSchema | null = null>(
		def: ProcedureDef<I, O, Acc>,
	): Procedure<'mutation', I, O, Acc>
	/** Procedures served at `POST <prefix>/<name>`, to the callers named once here. There is no public caller. */
	rpc<const C extends readonly [RpcCaller, ...RpcCaller[]], const T extends ProcedureTree>(
		prefix: Path,
		options: { readonly callers: C } & Owned<'kind' | 'prefix' | 'procedures'>,
		procedures: T,
	): RpcMount<C, T>
	/** A share SPA under `prefix` and its procedures under `<prefix>/api`, for an anonymous key bound to one object. */
	link<const LD extends D, const G extends readonly [A, ...A[]], const IB extends A, const T extends LinkProcedureTree>(
		prefix: Path,
		options: {
			readonly spa: string
			readonly dimension: LD
			readonly grants: G
			readonly issuedBy: IB
			readonly maxDays: number
			readonly procedures: (l: LinkKit<G[number]>) => T
		} & Owned<'kind' | 'prefix'>,
	): LinkMount<LD, G[number], IB, T>
	/** The SPA under `prefix`, for signed-in people only. */
	spa<const Acc extends MemberAccess | OverAccess<A, D>>(
		prefix: Path,
		options: { readonly dir: string; readonly access: Acc } & Owned<'kind' | 'prefix'>,
	): SpaMount<Acc>
	health(path: Path): HealthMount
	form<I extends InputSchema>(
		path: Path,
		options: { readonly input: I & NotLoose<I>; readonly appendTo: string; readonly maxBytes?: number } & Owned<'kind' | 'path'>,
	): FormMount<I>
	webhook<const B extends D | 'app', const Acts extends readonly [A, ...A[]], I extends InputSchema>(
		path: Path,
		options: {
			readonly scheme: 'github-sha256'
			readonly boundTo: B
			readonly actions: Acts
			readonly input: I & NotLoose<I>
			readonly maxBytes?: number
		} & Owned<'kind' | 'path'>,
	): WebhookMount<B, Acts[number], I>
	files(
		collection: {
			readonly owner: string
			readonly read: A
			readonly write: A
			readonly delete: A
			readonly maxBytes: number
			readonly types: readonly [string, ...string[]]
			readonly maxPerOwner?: number
			readonly link?: boolean
		} & Owned<'kind'>,
	): FileCollection<A>
	cron<const Acts extends readonly [A, ...A[]], const Sc extends D | 'app'>(
		schedule: string,
		options: { readonly actions: Acts; readonly scope: Sc; readonly timeout?: string; readonly retries?: number } & Owned<'kind' | 'schedule'>,
	): CronJob<Acts[number], Sc>
	export<const T extends QueryTree>(
		definition: {
			readonly version: number
			readonly consumers: readonly [string, ...string[]]
			readonly audience: 'any consumer user'
			readonly procedures: T
		} & Owned<'kind'>,
	): Export<T>
}

// ── The contract ────────────────────────────────────────────────────────────────────────────────

export interface Contract<A extends string, D extends string, R extends string, Dims, S extends Surface> {
	readonly vocabulary: Vocabulary<A, D, R>
	/** The dimension definitions as written, with their literal actions and roles, for the types only. */
	readonly dimensions: Dims
	readonly surface: S
}

export type AnyContract = Contract<string, string, string, unknown, Surface>

export type ActionOf<C> = C extends Contract<infer A, string, string, unknown, Surface> ? A : never
export type DimensionOf<C> = C extends Contract<string, infer D, string, unknown, Surface> ? D : never
export type RoleOf<C> = C extends Contract<string, string, infer R, unknown, Surface> ? R : never

function procedure<T extends ProcedureType, I extends InputSchema | null, O extends Schema, Acc>(
	type: T,
	def: ProcedureDef<I, O, Acc>,
): Procedure<T, I, O, Acc> {
	return {
		'~kind': 'procedure',
		type,
		input: def.input ?? null,
		output: def.output,
		access: def.access,
		unknownOptions: unknownOptions(def, 'procedure'),
	}
}

function linkKit<A extends string>(): LinkKit<A> {
	return {
		query: (def) => procedure('query', def),
		mutation: (def) => procedure('mutation', def),
	}
}

function kit<A extends string, D extends string, CD extends string>(): Kit<A, D, CD> {
	return {
		query: (def) => procedure('query', def),
		mutation: (def) => procedure('mutation', def),
		rpc: (prefix, options, procedures) => ({
			kind: 'rpc',
			prefix,
			callers: options.callers,
			procedures,
			unknownOptions: unknownOptions(options, 'rpc'),
		}),
		link: (prefix, options) => ({
			kind: 'link',
			prefix,
			spa: options.spa,
			dimension: options.dimension,
			grants: options.grants,
			issuedBy: options.issuedBy,
			maxDays: options.maxDays,
			procedures: options.procedures(linkKit()),
			unknownOptions: unknownOptions(options, 'link'),
		}),
		spa: (prefix, options) => ({ kind: 'spa', prefix, dir: options.dir, access: options.access, unknownOptions: unknownOptions(options, 'spa') }),
		health: (path) => ({ kind: 'health', path }),
		form: (path, options) => ({
			kind: 'form',
			path,
			input: options.input,
			appendTo: options.appendTo,
			maxBytes: options.maxBytes,
			unknownOptions: unknownOptions(options, 'form'),
		}),
		webhook: (path, options) => ({
			kind: 'webhook',
			path,
			scheme: options.scheme,
			boundTo: options.boundTo,
			actions: options.actions,
			input: options.input,
			maxBytes: options.maxBytes,
			unknownOptions: unknownOptions(options, 'webhook'),
		}),
		files: (collection) => ({
			kind: 'files',
			owner: collection.owner,
			read: collection.read,
			write: collection.write,
			delete: collection.delete,
			maxBytes: collection.maxBytes,
			types: collection.types,
			maxPerOwner: collection.maxPerOwner,
			link: collection.link,
			unknownOptions: unknownOptions(collection, 'files'),
		}),
		cron: (schedule, options) => ({
			kind: 'cron',
			schedule,
			actions: options.actions,
			scope: options.scope,
			timeout: options.timeout,
			retries: options.retries,
			unknownOptions: unknownOptions(options, 'cron'),
		}),
		export: (definition) => ({
			kind: 'export',
			version: definition.version,
			consumers: definition.consumers,
			audience: definition.audience,
			procedures: definition.procedures,
			unknownOptions: unknownOptions(definition, 'export'),
		}),
	}
}

/**
 * Declares the contract: the authorization vocabulary, then the surface built from `c` — mounts by name, and the
 * `files`, `jobs`, `exports`, `imports` and `csp` sections. The contract is a literal (`@fabrika/check`).
 */
export function defineContract<
	const A extends string,
	const D extends string,
	const R extends string,
	const Dims extends { readonly [K in D]: DimensionDef<NoInfer<A>, NoInfer<D>, NoInfer<R>> },
	const S extends Surface,
>(
	vocabulary: {
		readonly app: string
		readonly dimensions: Dims & { readonly [K in D]: DimensionDef<NoInfer<A>, NoInfer<D>, NoInfer<R>> }
		readonly actions: { readonly [K in A]: K extends `${string}*${string}` ? WildcardMessage : string }
		readonly roles: { readonly [K in R]: RoleDef<NoInfer<A>, NoInfer<D>, NoInfer<R>> }
	},
	surface: (c: Kit<A, D, CreatableDimension<Dims>>) => S,
): Contract<A, D, R, Dims, S> {
	return {
		vocabulary: { app: vocabulary.app, dimensions: vocabulary.dimensions, actions: vocabulary.actions, roles: vocabulary.roles },
		dimensions: vocabulary.dimensions,
		surface: surface(kit()),
	}
}
