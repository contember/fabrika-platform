// `defineContract`: the application's whole access surface as data. Browser-safe: it builds plain objects and
// holds zod schemas; it validates nothing at runtime, `compileContract` does.

import type { BuiltinRoleKey, ChallengeProvider, Locale, MailTemplates, RpcCaller, WebhookScheme } from '@fabrika/auth-core'
import type { z } from 'zod/v4'
import {
	type CronDeclaration,
	type CspDeclaration,
	type ExportAccessDeclaration,
	type ExportDeclaration,
	type FileKindDeclaration,
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
import type { TokenPurposes } from './token'

export type Path = `/${string}`

/** A job attempt's time limit: 15 minutes by default, at most a day. A job reads no body, so it has no `maxBytes`. */
export interface JobLimitsOption {
	readonly timeoutMs?: number
}

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

/** What a vocabulary's role of a reserved name must be instead: the refusal, at the role's own line. */
export type ReservedRoleMessage =
	`${BuiltinRoleKey} is a role IAM defines itself for every application (reserved: ${BuiltinRoleKey}): choose another name`

/** A vocabulary's roles: each a `RoleDef`, and none of a name IAM reserves. */
export type RoleDefs<A extends string, D extends string, R extends string> =
	& { readonly [K in R]: RoleDef<A, D, NoInfer<R>> }
	& (string extends R ? unknown : { readonly [K in NoInfer<R> & BuiltinRoleKey]: ReservedRoleMessage })

// ── Vocabulary ──────────────────────────────────────────────────────────────────────────────────

export interface DimensionDef<A extends string, D extends string, R extends string> {
	/** Containment: every value of this dimension lies in exactly one value of `in`. */
	readonly in?: D
	/** `creates: <dimension>` mints a value and grants the caller this role in it. */
	readonly creator?: R
	/** The action that manages the dimension's members, and the one that lists them. */
	readonly members?: { readonly manage: A; readonly list: A }
	/**
	 * `'labels'`: `ctx.members.list()` of a `members.list` endpoint also answers each member's label, for a people
	 * picker. A user's label spells its address, so this widens what members see of each other: a reviewed declaration.
	 */
	readonly directory?: 'labels'
}

export interface RoleDef<A extends string, D extends string, R extends string> {
	/** Exact actions only: `'*'` and `'notes.*'` are not actions of this contract. */
	readonly grants: readonly A[]
	/**
	 * A membership role, granted in one value of `scope`. `assignableBy` names who may assign it there: a holder of one
	 * of its membership roles of `scope` in that value, or of an application-wide role (one with no `member`) globally.
	 */
	readonly member?: { readonly scope: D; readonly assignableBy: readonly R[] }
	/**
	 * An external principal, a person from outside the organization, may hold this membership role (ADR-0051). Absent,
	 * only internal people hold it. Only a role with `member` may declare it; an internal person may hold it too.
	 */
	readonly external?: true
}

export interface Vocabulary<A extends string, D extends string, R extends string> extends Presentation, AppPeople<A> {
	readonly app: string
	readonly dimensions: { readonly [K in D]: DimensionDef<A, D, R> }
	readonly actions: { readonly [K in A]: string }
	readonly roles: { readonly [K in R]: RoleDef<A, D, R> }
}

/** The actions that manage and list the application's own people. */
export interface AppMembers<A extends string> {
	readonly manage: A
	readonly list: A
}

/**
 * The application's own people: every holder of one of its roles, globally or in a value. A holder of `members.manage`,
 * globally, grants and revokes the application's global roles in IAM's console within its own actions; an `app: true`
 * endpoint whose action is `members.list` reads them (`ctx.members.list()`).
 */
export interface AppPeople<A extends string> {
	readonly members?: AppMembers<A>
	/** `'labels'`: the directory also answers each person's label to a `members.list` holder. A reviewed declaration. */
	readonly directory?: 'labels'
}

/** A vocabulary's people fields, copied one by one: each exists only when declared. */
export function peopleOf<A extends string>(vocabulary: AppPeople<A>): AppPeople<A> {
	return {
		...(vocabulary.members === undefined ? {} : { members: { manage: vocabulary.members.manage, list: vocabulary.members.list } }),
		...(vocabulary.directory === undefined ? {} : { directory: vocabulary.directory }),
	}
}

/** How IAM names the application to a person: on its sign-in, password and invitation pages, and in its e-mails. */
export interface Presentation {
	/** The language of those pages and e-mails; absent, the installation's default. */
	readonly locale?: Locale
	/** The application's name there, plain text of one short line; absent, a wording without a name. */
	readonly displayName?: string
	/** The application's subject and text of IAM's e-mails, by message and language; absent, IAM's own wording. */
	readonly mail?: MailTemplates
}

/** A vocabulary's presentation fields, copied one by one: each exists only when declared. */
export function presentationOf(vocabulary: Presentation): Presentation {
	return {
		...(vocabulary.locale === undefined ? {} : { locale: vocabulary.locale }),
		...(vocabulary.displayName === undefined ? {} : { displayName: vocabulary.displayName }),
		...(vocabulary.mail === undefined ? {} : { mail: vocabulary.mail }),
	}
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
/** The action held as a global grant: data of the whole application (`ctx.db.app`). */
export interface AppAccess<A extends string> {
	readonly action: A
	readonly app: true
}
export interface LinkAccess<A extends string> {
	readonly action: A
}
/**
 * Anyone opens it, with no session: an SPA whose page reaches only the anonymous endpoints, or a procedure whose
 * handler runs as its own workload, holding the `actions` declared beside it.
 */
export interface PublicAccess {
	readonly public: true
}

/** Without an `input`, TS infers `I` as its whole constraint, not the `null` default; both mean "no input". */
export type InputOf<I> = [I] extends [InputSchema] ? z.output<I> : Record<never, never>

/** Input fields of string type: the only fields a scope value can be read from. */
export type StringField<In> = { [K in keyof In]-?: In[K] extends string ? K : never }[keyof In] & string

/** One of several capabilities: an action listed over a dimension, or held on or in the value an input field names. */
export type CapabilityAccess<A extends string, D extends string, In> =
	| OverAccess<A, D>
	| InAccess<A, D, StringField<In>>
	| OnAccess<A, D, StringField<In>>

/**
 * Several capabilities, by the name the handler reads each under (`ctx.capabilities.<name>`): an operation that reads
 * one dimension and writes another holds both, each checked and minted as its own access form would be.
 */
export interface CapabilitiesAccess<C> {
	readonly capabilities: C
}

export type QueryAccess<A extends string, D extends string, In> =
	| MemberAccess
	| OverAccess<A, D>
	| InAccess<A, D, StringField<In>>
	| OnAccess<A, D, StringField<In>>
	| AppAccess<A>
	| CapabilitiesAccess<{ readonly [name: string]: CapabilityAccess<A, D, In> }>

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
	/** A page on one of the environment's listed origins may call it, with a key (ADR-0022). An RPC procedure only. */
	readonly crossOrigin?: true
}

/** `C` names the callers of its credentialed procedures; `readonly []` when every procedure is public. */
export interface RpcMount<C extends readonly RpcCaller[], T extends ProcedureTree> extends RpcMountDeclaration<Schema> {
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

export interface WebhookMount<B extends string, Acts extends string, I extends Schema> extends WebhookMountDeclaration<Schema> {
	readonly boundTo: B
	readonly actions: readonly Acts[]
	readonly input: I
}

/** A file kind `c.files({ types, maxBytes, scan? })` declares: what a file column of that kind holds. */
export interface FileKind extends FileKindDeclaration {}

export interface CronJob<Acts extends string> extends CronDeclaration {
	readonly actions: readonly Acts[]
}

export interface Export<T extends QueryTree> extends ExportDeclaration<Schema> {
	readonly procedures: T
}

export type AnyMount =
	| RpcMount<readonly RpcCaller[], ProcedureTree>
	| LinkMount<string, string, string, LinkProcedureTree>
	| SpaMount<SpaAccessDeclaration>
	| HealthMount
	| WebhookMount<string, string, Schema>

/** What the callback of `defineContract` returns: mounts by name, and the sections `SURFACE_SECTIONS` names. */
export interface SurfaceSections {
	readonly files?: { readonly [name: string]: FileKind }
	readonly jobs?: { readonly [name: string]: CronJob<string> }
	readonly exports?: { readonly [name: string]: Export<QueryTree> }
	readonly imports?: { readonly [name: string]: ImportDeclaration }
	readonly csp?: CspDeclaration
	/** The token purposes; a kit contract takes them from `defineApp`'s options. */
	readonly tokens?: TokenPurposes
}

export interface Surface extends SurfaceSections {
	readonly [name: string]: AnyMount | SurfaceSections[keyof SurfaceSections]
}

/** A public procedure's challenge: the provider and the application variables that hold its secret and its public site key. */
export interface ChallengeOption {
	readonly provider: ChallengeProvider
	readonly secret: string
	/** Served by every SPA mount at `<prefix>/__fabrika-config.json`, so the page renders the widget with it. */
	readonly siteKey?: string
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
	/** The SPA under `prefix`: for signed-in people, or for anyone with `access: { public: true }`. */
	spa<const Acc extends MemberAccess | OverAccess<A, D> | AppAccess<A> | PublicAccess>(
		prefix: Path,
		options: {
			readonly dir: string
			readonly access: Acc
			/** Application variables whose values the pages read from `<prefix>/__fabrika-config.json`: public values only. */
			readonly public?: readonly [string, ...string[]]
		} & Owned<'kind' | 'prefix'>,
	): SpaMount<Acc>
	health(path: Path): HealthMount
	webhook<const B extends D | 'app', const Acts extends readonly [A, ...A[]], I extends InputSchema>(
		path: Path,
		options: {
			readonly scheme: WebhookScheme
			readonly boundTo: B
			readonly actions: Acts
			readonly input: I & NotLoose<I>
			/** A delivery's body (1 MiB by default and at most) and its handler's time (10 s by default, at most 60 s). */
			readonly limits?: { readonly maxBytes?: number; readonly timeoutMs?: number }
		} & Owned<'kind' | 'path'>,
	): WebhookMount<B, Acts[number], I>
	/**
	 * A file kind: the media types its files may be, the largest one, and whether each waits for a clean scan. A table's
	 * file column holds files of it (`files: { <column>: '<kind>' }`), and the table's actions are their authority.
	 */
	files(
		kind:
			& {
				readonly types: readonly [string, ...string[]]
				readonly maxBytes: number
				/** Each file is scanned for malware and served only after a clean verdict; until then it answers 409. */
				readonly scan?: boolean
			}
			& Owned<'kind'>,
	): FileKind
	/** A job of the whole application, holding `actions`; it runs on its schedule (UTC, five fields) and when kicked. */
	cron<const Acts extends readonly [A, ...A[]]>(
		schedule: string,
		options: { readonly actions: Acts; readonly limits?: JobLimitsOption; readonly retries?: number } & Owned<'kind' | 'schedule'>,
	): CronJob<Acts[number]>
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
		...(def.crossOrigin === undefined ? {} : { crossOrigin: def.crossOrigin }),
		unknownOptions: unknownOptions(def, 'procedure'),
	}
}

function linkKit<A extends string>(): LinkKit<A> {
	return {
		query: (def) => procedure('query', def),
		mutation: (def) => procedure('mutation', def),
	}
}

/** The builders `defineContract` hands its callback; the staged kit's contract reuses its mounts that take no handler. */
export function surfaceKit<A extends string, D extends string, CD extends string>(): Kit<A, D, CD> {
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
		spa: (prefix, options) => ({
			kind: 'spa',
			prefix,
			dir: options.dir,
			access: options.access,
			public: options.public,
			unknownOptions: unknownOptions(options, 'spa'),
		}),
		health: (path) => ({ kind: 'health', path }),
		webhook: (path, options) => ({
			kind: 'webhook',
			path,
			scheme: options.scheme,
			boundTo: options.boundTo,
			actions: options.actions,
			input: options.input,
			...(options.limits === undefined ? {} : { limits: options.limits }),
			unknownOptions: unknownOptions(options, 'webhook'),
		}),
		files: (kind) => ({
			kind: 'file-kind',
			types: kind.types,
			maxBytes: kind.maxBytes,
			scan: kind.scan,
			unknownOptions: unknownOptions(kind, 'fileKind'),
		}),
		cron: (schedule, options) => ({
			kind: 'cron',
			schedule,
			actions: options.actions,
			...(options.limits === undefined ? {} : { limits: options.limits }),
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
	vocabulary: Presentation & AppPeople<NoInfer<A>> & {
		readonly app: string
		readonly dimensions: Dims & { readonly [K in D]: DimensionDef<NoInfer<A>, NoInfer<D>, NoInfer<R>> }
		readonly actions: { readonly [K in A]: K extends `${string}*${string}` ? WildcardMessage : string }
		readonly roles: RoleDefs<NoInfer<A>, NoInfer<D>, R>
	},
	surface: (c: Kit<A, D, CreatableDimension<Dims>>) => S,
): Contract<A, D, R, Dims, S> {
	return {
		vocabulary: {
			app: vocabulary.app,
			dimensions: vocabulary.dimensions,
			actions: vocabulary.actions,
			roles: vocabulary.roles,
			...presentationOf(vocabulary),
			...peopleOf(vocabulary),
		},
		dimensions: vocabulary.dimensions,
		surface: surface(surfaceKit()),
	}
}
