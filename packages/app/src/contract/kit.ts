// `defineApp(vocabulary, tables)`: the staged kit. The vocabulary knows nothing, the tables know the vocabulary, the
// kit knows both, and the groups and the contract know the kit; nothing types itself by `typeof contract`, so the
// handlers beside their endpoints, in any module, type-check without a cycle. Browser-safe: it builds plain data and
// holds each handler beside its site (`handled.ts`), never calling one.

import type { JobMailer, RpcCaller, WebhookScheme } from '@fabrika/auth-core'
import type { AnyDbIndex, DbIndex, Tables, Unavailable, UnscopedDeclaration, UnscopedMode } from '@fabrika/db/tables'
import type { z } from 'zod/v4'
import type { Declared, JobKitContext, KickContext, KitImports, KitTypes, NoTablesIndex, SqlMode, TokensContext, WebhookKitContext } from './context'
import {
	type AccessDeclaration,
	type CronDeclaration,
	type DeclaredDeclaration,
	declaredOf,
	type ExportAccessDeclaration,
	type ExportDeclaration,
	type ImportDeclaration,
	isProcedure,
	kitUnknownOptions,
	type LinkAccessDeclaration,
	type LinkMountDeclaration,
	type ProcedureDeclaration,
	type ProcedureTreeDeclaration,
	type ProcedureType,
	type RpcMountDeclaration,
	unknownOptions,
	type WebhookMountDeclaration,
} from './declaration'
import type { FORM_CHALLENGE_FIELD } from './defaults'
import {
	type AnyContract,
	type Contract,
	type CreatableDimension,
	type CronJob,
	type Export,
	type FormChallengeOption,
	type FormFileOption,
	type FormJobs,
	type FormMount,
	type FormOptions,
	type InputSchema,
	type JobLimitsOption,
	type Kit,
	type LinkMount,
	type NotLoose,
	type Path,
	peopleOf,
	presentationOf,
	type ProcedureTree,
	type RpcMount,
	type Schema,
	type Surface,
	surfaceKit,
	type WebhookMount,
} from './define'
import type {
	DeclaredFields,
	EgressField,
	Endpoint,
	ExportKit,
	Group,
	GroupBuild,
	GroupInput,
	GroupKit,
	KicksField,
	LimitsOption,
	LinkGroupKit,
	ListOf,
	PendingIn,
	SignsField,
} from './group'
import { withHandler, withKitOrigin, withSnapshots } from './handled'
import { ContractError } from './problems'
import type { TokenPurposes } from './token'
import type { AnyAppVocabulary, AppVocabulary } from './vocabulary'

/** Fields a builder sets itself: an options object that carries one does not type-check. */
type Owned<K extends string> = { readonly [P in K]?: never }

/** The kit's types, computed once from the vocabulary, the tables' index, the imports and the token purposes. */
export type KitOf<V, Ix, Imp extends KitImports, Tk extends TokenPurposes = Record<never, never>> = V extends
	AppVocabulary<infer A, infer D, infer R, infer Dims, infer M> ? {
		readonly action: A
		readonly dimension: D
		readonly creatable: CreatableDimension<Dims>
		readonly role: R
		readonly dimensions: Dims
		readonly members: M
		readonly index: Ix
		readonly tables: Ix extends { readonly tables: infer T } ? keyof T & string : never
		readonly imports: Imp
		readonly tokens: Tk
	}
	: never

export type CronOptions<Acts, Sc, S, U, Is, Ix extends AnyDbIndex, M = never, Ks = never, Sg = never, Purposes extends string = never> =
	& Owned<'kind' | 'schedule'>
	& { readonly actions: Acts; readonly scope: Sc; readonly limits?: JobLimitsOption; readonly retries?: number }
	& DeclaredFields<S, U, never, Is, Ix>
	& MailerField<M>
	& KicksField<Ks>
	& SignsField<Sg, Purposes>
	& EgressField

/** The mail transport a job reaches, inferred from its optional field and then required, like a declared field. */
type MailerField<M> =
	& {
		/** `'installation'`: the installation's mail transport; `'own'`: the application's own. */
		readonly mailer?: M
	}
	& ([M] extends [never] ? unknown : { readonly mailer: M })

/** A cron job of the kit, handled. */
export interface KitCronJob<Acts extends string, Sc extends string, D> extends CronJob<Acts, Sc> {
	readonly declared: D
}

/** A cron job before `.handle`: the contract's `jobs` refuses it. */
export interface CronBuilder<
	K extends KitTypes,
	Acts extends string,
	Sc extends string,
	D extends Declared<SqlMode, unknown, never, string, JobMailer>,
	Ks = never,
	Sg = never,
> {
	handle(
		handler: (args: { readonly ctx: JobKitContext<K, Acts, D> & KickContext<Ks> & TokensContext<K, Sg> }) => void | Promise<void>,
	): KitCronJob<Acts, Sc, D>
}

export type WebhookOptions<B, Acts, I, S, U, Ix extends AnyDbIndex, Ks = never, Sg = never, Purposes extends string = never> =
	& Owned<'kind' | 'path'>
	& {
		readonly scheme: WebhookScheme
		readonly boundTo: B
		readonly actions: Acts
		readonly input: I & NotLoose<I>
		/** A delivery's body (1 MiB by default and at most) and its handler's time (10 s by default, at most 60 s). */
		readonly limits?: LimitsOption
	}
	& DeclaredFields<S, U, never, never, Ix>
	& KicksField<Ks>
	& SignsField<Sg, Purposes>
	& EgressField

/** A webhook of the kit, handled. */
export interface KitWebhook<B extends string, Acts extends string, I extends Schema, D> extends WebhookMount<B, Acts, I> {
	readonly declared: D
}

/** A webhook before `.handle`: the contract refuses it as a mount. */
export interface WebhookBuilder<
	K extends KitTypes,
	B extends string,
	Acts extends string,
	I extends InputSchema,
	D extends Declared<SqlMode, unknown, never, never>,
	Ks = never,
	Sg = never,
> {
	handle(
		handler: (
			args: { readonly input: z.output<I>; readonly ctx: WebhookKitContext<K, B, Acts, D> & KickContext<Ks> & TokensContext<K, Sg> },
		) => void | Promise<void>,
	): KitWebhook<B, Acts, I, D>
}

/** A link mount's procedures: handled endpoints whose access names one of the mount's granted actions. */
export interface LinkTree {
	readonly [name: string]: Endpoint<ProcedureType, InputSchema | null, Schema, LinkAccessDeclaration, unknown>
}

/** An export's procedures: handled queries. */
export interface ExportTree {
	readonly [name: string]: Endpoint<'query', InputSchema | null, Schema, ExportAccessDeclaration, unknown>
}

/** What `c.rpc` mounts: one group, or groups by name, nested. */
export type MountedGroups =
	| Group<readonly RpcCaller[], GroupInput>
	| { readonly [name: string]: MountedGroups }

/** The callers each group names; a group of public procedures names none and is left out. */
type CallersOf<G> = G extends Group<infer C, GroupInput> ? (C extends readonly [] ? never : C) : { [K in keyof G]: CallersOf<G[K]> }[keyof G]
type EndpointsOf<G> = G extends Group<readonly RpcCaller[], infer T> ? T : { readonly [K in keyof G]: EndpointsOf<G[K]> }

/** A group that names callers names at least one; a group of public procedures leaves `callers` out. */
type SomeCallers<C> = C extends readonly []
	? Unavailable<"callers names at least one caller: callers: ['human']; a group of public procedures names none">
	: unknown

/** The callers of the mount's credentialed procedures, `readonly []` when every group is public. */
type Callers<G> = [CallersOf<G>] extends [never] ? readonly [] : CallersOf<G> extends infer C extends readonly RpcCaller[] ? C : never
type Endpoints<G> = EndpointsOf<G> extends infer T extends ProcedureTree ? T : never

type IsUnion<T, All = T> = T extends unknown ? ([All] extends [T] ? false : true) : never

type PendingOf<G, Path extends string = ''> = G extends Group<readonly RpcCaller[], infer T> ? PendingIn<T, Path>
	: { [K in keyof G & string]: PendingOf<G[K], `${Path}${K}.`> }[keyof G & string]

/**
 * A mount takes its prefix only when it can serve every group: each endpoint took its `.handle(…)` (a group accepts
 * one without, because its own callback cannot be checked before it is typed), and every group names the same callers.
 */
type MountPrefix<G> = [PendingOf<G>] extends [never]
	? true extends IsUnion<CallersOf<G>> ? Unavailable<'every group of one RPC mount that names callers names the same ones, in the same order'>
	: Path
	: Unavailable<`add .handle(…) to ${ListOf<PendingOf<G>>}: every endpoint takes its handler beside it`>

/** The inbox tables of the kit: each a form's own table (`scope: { inbox, read }`). */
type InboxTables<Ix extends AnyDbIndex> = {
	[T in keyof Ix['tables'] & string]: Ix['tables'][T]['mode'] extends 'inbox' ? T : never
}[keyof Ix['tables'] & string]

/** `unknown` for one literal name; a widened or union name would let the check below pass for any other. */
type OneName<N, Message extends string> = string extends N ? Unavailable<Message> : true extends IsUnion<N> ? Unavailable<Message> : unknown

type LiteralInbox = "appendTo names the form's inbox table as a literal: appendTo: '<inbox table>'"
type LiteralHoneypot = "honeypot names the field the page hides as a literal: honeypot: '<field>'"

/**
 * `appendTo` names one inbox table, and the form's input fields are its columns, the honeypot `H` and the challenge
 * token `Ch` exempt: the form writes each field to the column of its name. A widened honeypot is refused here too,
 * since it would exempt every field.
 */
type InboxTarget<Ix extends AnyDbIndex, T, Fields, H, Ch> = unknown extends OneName<T, LiteralInbox>
	? T extends InboxTables<Ix> & string
		? unknown extends OneName<H, LiteralHoneypot>
			? ExtraFields<T, Exclude<Fields & string, keyof Ix['tables'][T]['row'] | H | Ch>, keyof Ix['tables'][T]['row'] & string>
		: OneName<H, LiteralHoneypot>
	: [InboxTables<Ix>] extends [never]
		? Unavailable<"no table of src/db/tables.ts is a form's inbox: declare one with scope: { inbox: '<form>', read }">
	: Unavailable<`${T & string} is not an inbox table of src/db/tables.ts (inboxes: ${ListOf<InboxTables<Ix> & string>})`>
	: OneName<T, LiteralInbox>

type ExtraFields<T extends string, Extra extends string, Columns extends string> = [Extra] extends [never] ? unknown
	: Unavailable<`the inbox ${T} has no column ${ListOf<Extra>}: each input and file field is named like its column (columns: ${ListOf<Columns>})`>

/** The challenge token's field, exempt from the inbox's columns where the form declares a challenge. */
type ChallengeField<Ch> = [Ch] extends [never] ? never : typeof FORM_CHALLENGE_FIELD

/** A form's file fields: each is a column of its inbox too, which receives the held file's id. */
type FileFields<F> = [F] extends [never] ? never : keyof F

/** The builders of the contract's callback: the mounts that take no handler, and `rpc`, which mounts groups. */
export interface ContractKit<K extends KitTypes> extends Pick<Kit<K['action'], K['dimension'], K['creatable']>, 'spa' | 'health' | 'files'> {
	/** A form that appends each submission to its inbox `appendTo`, one column per input field, and answers a constant. */
	form<
		I extends InputSchema,
		const T extends string,
		const H extends string = never,
		const Ch extends FormChallengeOption = never,
		const Then extends string = never,
		const F extends { readonly [field: string]: FormFileOption } = never,
	>(
		path: Path,
		options: FormOptions<I, Then> & {
			readonly appendTo: T & NoInfer<InboxTarget<K['index'], T, keyof z.output<I> | FileFields<F>, H, ChallengeField<Ch>>>
			readonly honeypot?: H & NoInfer<OneName<H, LiteralHoneypot>>
			readonly challenge?: Ch
			readonly files?: F
		},
	): FormMount<I, NoInfer<Then>>
	/**
	 * The groups' endpoints at `POST <prefix>/<group>.<endpoint>`, to the callers the groups name. `compatibility:
	 * 'backward'` promises their callers that a later deploy breaks none of them; Control refuses one that does.
	 */
	rpc<const G extends MountedGroups>(
		prefix: MountPrefix<G>,
		groups: G,
		options?: RpcMountOptions,
	): RpcMount<Callers<G>, Endpoints<G>>
}

/** The options of `c.rpc`: the promise the mount makes its callers, `'unchecked'` by default. */
export interface RpcMountOptions {
	readonly compatibility?: 'backward' | 'unchecked'
}

/** The `imports` section the contract carries: the kit's imports, with `usedBy` from the endpoints' `connect`. */
type ImportsSection<K extends KitTypes> = [keyof K['imports']] extends [never] ? unknown
	: { readonly imports: { readonly [N in keyof K['imports']]: ImportDeclaration } }

/** The `tokens` section the contract carries: the kit's token purposes, as `defineApp`'s options declare them. */
type TokensSection<K extends KitTypes> = [keyof K['tokens']] extends [never] ? unknown : { readonly tokens: K['tokens'] }

/** The contract `app.contract` returns: the same `Contract` the client, the compiler and the test kit read. */
export type KitContract<K extends KitTypes, S extends Surface> = Contract<
	K['action'],
	K['dimension'],
	K['role'],
	K['dimensions'],
	S & ImportsSection<K> & TokensSection<K>
>

/** The kit of one application: every builder is typed by its vocabulary, its tables and its imports. */
export interface App<K extends KitTypes> {
	/**
	 * Endpoints for `callers`, declared and handled together; `fabrika.contract.ts` mounts the group with `c.rpc`. A group
	 * of public procedures only (`access: { public: true }`), which anyone calls, names no callers: `app.group({}, …)`.
	 */
	group<const C extends readonly RpcCaller[] = readonly [], const T extends GroupBuild = GroupBuild>(
		options: { readonly callers?: C & NoInfer<SomeCallers<C>> } & Owned<'kind' | 'endpoints'>,
		build: (r: GroupKit<K, C[number]>) => T,
	): Group<C, T>
	/** A cron job (UTC, five fields) holding `actions` in `scope`; the contract mounts it under `jobs`. */
	cron<
		const Acts extends readonly [K['action'], ...K['action'][]],
		const Sc extends K['dimension'] | 'app',
		const S extends SqlMode = never,
		const U extends UnscopedDeclaration<K['tables'], UnscopedMode> = never,
		const Is extends string = never,
		const M extends JobMailer = never,
		const Ks extends readonly string[] = never,
		const Sg extends readonly string[] = never,
	>(
		schedule: string,
		options: CronOptions<Acts, Sc, S, U, Is, K['index'], M, Ks, Sg, keyof K['tokens'] & string>,
	): CronBuilder<K, Acts[number], Sc, Declared<S, U, never, Is, M>, Ks, Sg>
	/**
	 * A webhook whose deliveries `scheme` verifies, bound per value of `boundTo` or once for the application (`'app'`);
	 * the contract mounts it by name.
	 */
	webhook<
		const B extends K['dimension'] | 'app',
		const Acts extends readonly [K['action'], ...K['action'][]],
		I extends InputSchema,
		const S extends SqlMode = never,
		const U extends UnscopedDeclaration<K['tables'], UnscopedMode> = never,
		const Ks extends readonly string[] = never,
		const Sg extends readonly string[] = never,
	>(
		path: Path,
		options: WebhookOptions<B, Acts, I, S, U, K['index'], Ks, Sg, keyof K['tokens'] & string>,
	): WebhookBuilder<K, B, Acts[number], I, Declared<S, U, never, never>, Ks, Sg>
	/** A share SPA under `prefix` and its procedures under `<prefix>/api`, for an anonymous key bound to one object. */
	link<
		const LD extends K['dimension'],
		const G extends readonly [K['action'], ...K['action'][]],
		const IB extends K['action'],
		const T extends LinkTree,
	>(
		prefix: Path,
		options: {
			readonly spa: string
			readonly dimension: LD
			readonly grants: G
			readonly issuedBy: IB
			readonly maxDays: number
			readonly procedures: (l: LinkGroupKit<K, LD, G[number]>) => T
		} & Owned<'kind' | 'prefix'>,
	): LinkMount<LD, G[number], IB, T>
	/** Read-only queries another application's connector calls; the contract mounts it under `exports`. */
	export<const T extends ExportTree>(
		definition: {
			readonly version: number
			readonly consumers: readonly [string, ...string[]]
			readonly audience: 'any consumer user'
			readonly procedures: (e: ExportKit<K>) => T
		} & Owned<'kind'>,
	): Export<T>
	/**
	 * The contract: mounts by name and the `files`, `jobs`, `exports` and `csp` sections; `imports` and `tokens` come from
	 * the kit.
	 */
	contract<const S extends Surface & Owned<'imports' | 'tokens'> & FormJobs<S>>(build: (c: ContractKit<K>) => S): KitContract<K, S>
}

/**
 * The application's kit, built once in `src/app-kit.ts`: `defineApp(vocabulary, tables)`, plus the connectors it
 * imports (`{ imports: { <name>: { snapshot, procedures, timeoutMs? } } }`). The tables' `DbIndex` is computed here,
 * once, so each endpoint's `ctx.db` is a lookup.
 *
 * This signature is the kit's typed face over `RuntimeApp`, which builds plain declarations. The face answers types
 * no implementation can return (`.handle`'s `ExactReturn`, `contract`'s `imports` section by the kit's imports), so
 * the compiler relates the two nowhere else; `kit-runtime.test.ts` holds that each builder returns what its type says.
 */
export function defineApp<V extends AnyAppVocabulary>(vocabulary: V): App<KitOf<V, NoTablesIndex, Record<never, never>>>
export function defineApp<V extends AnyAppVocabulary, DB, P>(
	vocabulary: V,
	tables: Tables<DB, P>,
): App<KitOf<V, DbIndex<DB, P, V>, Record<never, never>>>
/**
 * Options that may be absent are no overload, and neither is an option field that may be absent: the contract's type
 * would promise an imports section, or token purposes, it may not have. Each overload requires the fields it infers.
 */
export function defineApp<V extends AnyAppVocabulary, DB, P, const Imp extends KitImports, const Tk extends TokenPurposes>(
	vocabulary: V,
	tables: Tables<DB, P>,
	options: { readonly imports: Imp; readonly tokens: Tk },
): App<KitOf<V, DbIndex<DB, P, V>, Imp, Tk>>
export function defineApp<V extends AnyAppVocabulary, DB, P, const Tk extends TokenPurposes>(
	vocabulary: V,
	tables: Tables<DB, P>,
	options: { readonly tokens: Tk },
): App<KitOf<V, DbIndex<DB, P, V>, Record<never, never>, Tk>>
export function defineApp<V extends AnyAppVocabulary, DB, P, const Imp extends KitImports>(
	vocabulary: V,
	tables: Tables<DB, P>,
	options: { readonly imports: Imp },
): App<KitOf<V, DbIndex<DB, P, V>, Imp>>
export function defineApp(vocabulary: AnyAppVocabulary, tables?: unknown, options?: KitOptions): object {
	return runtimeApp(vocabulary, options, tables !== undefined)
}

/** What `defineApp`'s options carry: the connectors the kit imports, and the purposes of the tokens it signs. */
export interface KitOptions {
	readonly imports?: KitImports
	/** `{ <purpose>: token(Claims, { maxDays }) }`: each kind of signed token, declared once. */
	readonly tokens?: TokenPurposes
}

// ── The runtime ─────────────────────────────────────────────────────────────────────────────────

/** A site before `.handle`: its declaration as own fields, and `handle` on the prototype, so a spread copies only them. */
class Pending<T extends object> {
	readonly #declaration: T

	constructor(declaration: T) {
		this.#declaration = declaration
	}

	/** A copy of the declaration that carries `handler`; the pending site itself stays without one. */
	handle(handler: unknown): T {
		return withHandler({ ...this.#declaration }, handler)
	}
}

type PendingSite<T extends object> = Pending<T> & T

const pending = <T extends object>(declaration: T): PendingSite<T> => Object.assign(new Pending(declaration), declaration)

interface EndpointOptions<Access> extends DeclaredDeclaration {
	readonly input?: Schema | null
	readonly output: Schema
	readonly access: Access
	readonly crossOrigin?: true
	readonly actions?: readonly string[]
	readonly admission?: object
	readonly limits?: object
	readonly http?: object
}

function endpoint<Access>(type: ProcedureType, def: EndpointOptions<Access>): PendingSite<ProcedureDeclaration<Schema, Access>> {
	const declaration: ProcedureDeclaration<Schema, Access> = {
		'~kind': 'procedure',
		type,
		input: def.input ?? null,
		output: def.output,
		access: def.access,
		...(def.crossOrigin === undefined ? {} : { crossOrigin: def.crossOrigin }),
		...(def.actions === undefined ? {} : { actions: def.actions }),
		...(def.admission === undefined ? {} : { admission: def.admission }),
		...(def.limits === undefined ? {} : { limits: def.limits }),
		...(def.http === undefined ? {} : { http: def.http }),
		declared: declaredOf(def),
		unknownOptions: kitUnknownOptions(def, 'procedure'),
	}
	return pending(declaration)
}

interface RuntimeEndpointKit<Access> {
	query(def: EndpointOptions<Access>): PendingSite<ProcedureDeclaration<Schema, Access>>
	mutation(def: EndpointOptions<Access>): PendingSite<ProcedureDeclaration<Schema, Access>>
}

const endpointKit = <Access>(): RuntimeEndpointKit<Access> => ({
	query: (def) => endpoint('query', def),
	mutation: (def) => endpoint('mutation', def),
})

/** A group as data: its callers and its endpoints, which a mount nests by name. A group of public procedures has none. */
interface GroupDeclaration {
	readonly '~kind': 'group'
	readonly callers: readonly RpcCaller[]
	readonly endpoints: ProcedureTreeDeclaration<Schema>
}

/** What `app.group` returns at runtime; `unknownOptions` are the group's option keys besides `callers`. */
interface RuntimeGroup extends GroupDeclaration {
	readonly unknownOptions: readonly string[]
}

interface CronSiteOptions extends DeclaredDeclaration {
	readonly actions: readonly string[]
	readonly scope: string
	readonly limits?: object
	readonly retries?: number
}

interface WebhookSiteOptions extends DeclaredDeclaration {
	readonly scheme: WebhookScheme
	readonly boundTo: string
	readonly actions: readonly string[]
	readonly input: Schema
	readonly limits?: object
}

interface LinkSiteOptions {
	readonly spa: string
	readonly dimension: string
	readonly grants: readonly string[]
	readonly issuedBy: string
	readonly maxDays: number
	readonly procedures: (l: RuntimeEndpointKit<LinkAccessDeclaration>) => ProcedureTreeDeclaration<Schema, LinkAccessDeclaration>
}

interface ExportSiteOptions {
	readonly version: number
	readonly consumers: readonly string[]
	readonly audience: string
	readonly procedures: (e: Pick<RuntimeEndpointKit<ExportAccessDeclaration>, 'query'>) => ProcedureTreeDeclaration<Schema, ExportAccessDeclaration>
}

type MountedGroupsValue = GroupDeclaration | { readonly [name: string]: MountedGroupsValue }

interface RuntimeContractKit extends Pick<Kit<string, string, string>, 'spa' | 'health' | 'form' | 'files'> {
	rpc(prefix: Path, groups: MountedGroupsValue, options?: object): RpcMountDeclaration<Schema>
}

interface RuntimeApp {
	group(
		options: { readonly callers?: readonly RpcCaller[] },
		build: (r: RuntimeEndpointKit<AccessDeclaration>) => ProcedureTreeDeclaration<Schema>,
	): RuntimeGroup
	cron(schedule: string, options: CronSiteOptions): PendingSite<CronDeclaration>
	webhook(path: Path, options: WebhookSiteOptions): PendingSite<WebhookMountDeclaration<Schema>>
	link(prefix: Path, options: LinkSiteOptions): LinkMountDeclaration<Schema>
	export(definition: ExportSiteOptions): ExportDeclaration<Schema>
	contract(build: (c: RuntimeContractKit) => Surface): AnyContract
}

/**
 * `options` is what `defineApp`'s options carry; the contract has an imports or a tokens section exactly when they carry
 * one. `tables` is whether the kit was given tables: a contract of a kit without them is served without a database.
 */
function runtimeApp(vocabulary: AnyAppVocabulary, options: KitOptions | undefined, tables: boolean): RuntimeApp {
	const imports = options?.imports
	const tokens = options?.tokens
	return {
		group: (options, build) => {
			const callers = options.callers ?? []
			const endpoints = build(endpointKit())
			if (callers.length === 0) {
				const credentialed = procedureEntries(endpoints).filter(([, procedure]) => !isPublicAccess(procedure.access)).map(([path]) => path)
				if (credentialed.length > 0) {
					throw new ContractError([
						`app.group: ${credentialed.join(', ')} ${
							credentialed.length === 1 ? 'is' : 'are'
						} not public, and the group names no callers (allowed: app.group({ callers: ['human'] }, …), or access: { public: true })`,
					])
				}
			}
			return { '~kind': 'group', callers, endpoints, unknownOptions: unknownOptions(options, 'rpc') }
		},
		cron: (schedule, options) => {
			const declaration: CronDeclaration = {
				kind: 'cron',
				schedule,
				actions: options.actions,
				scope: options.scope,
				...(options.limits === undefined ? {} : { limits: options.limits }),
				retries: options.retries,
				declared: declaredOf(options),
				unknownOptions: kitUnknownOptions(options, 'cron'),
			}
			return pending(declaration)
		},
		webhook: (path, options) => {
			const declaration: WebhookMountDeclaration<Schema> = {
				kind: 'webhook',
				path,
				scheme: options.scheme,
				boundTo: options.boundTo,
				actions: options.actions,
				input: options.input,
				...(options.limits === undefined ? {} : { limits: options.limits }),
				declared: declaredOf(options),
				unknownOptions: kitUnknownOptions(options, 'webhook'),
			}
			return pending(declaration)
		},
		link: (prefix, options) => ({
			kind: 'link',
			prefix,
			spa: options.spa,
			dimension: options.dimension,
			grants: options.grants,
			issuedBy: options.issuedBy,
			maxDays: options.maxDays,
			procedures: options.procedures(endpointKit()),
			unknownOptions: unknownOptions(options, 'link'),
		}),
		export: (definition) => ({
			kind: 'export',
			version: definition.version,
			consumers: definition.consumers,
			audience: definition.audience,
			procedures: definition.procedures(endpointKit()),
			unknownOptions: unknownOptions(definition, 'export'),
		}),
		contract: (build) => {
			const shared = surfaceKit()
			const surface = build({ rpc, spa: shared.spa, health: shared.health, form: shared.form, files: shared.files })
			if (surface.imports !== undefined) {
				throw new ContractError(['contract: imports come from defineApp(vocabulary, tables, { imports }); remove the section'])
			}
			if (surface.tokens !== undefined) {
				throw new ContractError(['contract: tokens come from defineApp(vocabulary, tables, { tokens }); remove the section'])
			}
			const withImports = imports === undefined ? surface : { ...surface, imports: kitImportsSection(importDeclarations(imports), surface) }
			const declared = tokens === undefined ? withImports : { ...withImports, tokens }
			const contract: AnyContract = {
				vocabulary: {
					app: vocabulary.app,
					dimensions: vocabulary.dimensions,
					actions: vocabulary.actions,
					roles: vocabulary.roles,
					...presentationOf(vocabulary),
					...peopleOf(vocabulary),
				},
				dimensions: vocabulary.dimensions,
				surface: declared,
			}
			const built = withSnapshots(contract, Object.fromEntries(Object.entries(imports ?? {}).map(([name, imported]) => [name, imported.snapshot])))
			return withKitOrigin(built, tables ? 'tables' : 'tableless')
		},
	}
}

/**
 * `c.rpc(prefix, groups, options?)`: the groups' endpoints under the prefix, nested by the names `groups` gives them.
 * `compatibility` is copied as written, and `buildArtifact` checks it.
 */
function rpc(prefix: Path, groups: MountedGroupsValue, options: object = {}): RpcMountDeclaration<Schema> {
	const mounted = mountedGroups(groups)
	if (mounted.length === 0) {
		throw new ContractError([`c.rpc('${prefix}'): mounts no group (allowed: c.rpc('${prefix}', { <name>: <group> }))`])
	}
	// A group of public procedures names no callers; every group that names them names the same ones.
	const credentialed = mounted.filter((group) => group.callers.length > 0)
	const callers = credentialed[0]?.callers ?? []
	if (credentialed.some((group) => !sameCallers(group.callers, callers))) {
		throw new ContractError([`c.rpc('${prefix}'): every group of one RPC mount that names callers names the same ones, in the same order`])
	}
	return {
		kind: 'rpc',
		prefix,
		callers,
		procedures: mountedProcedures(groups),
		...rpcMountOptions(prefix, options),
		unknownOptions: [...new Set(mounted.flatMap((group) => isRuntimeGroup(group) ? group.unknownOptions : []))],
	}
}

/** The `compatibility` of `c.rpc`'s options, only when written; it takes no other option. */
function rpcMountOptions(prefix: Path, options: object): { readonly compatibility?: unknown } {
	const unknown = Object.keys(options).filter((key) => key !== 'compatibility')
	if (unknown.length > 0) {
		throw new ContractError([`c.rpc('${prefix}'): ${unknown.map((key) => `'${key}'`).join(', ')} is not an option (allowed: compatibility)`])
	}
	const compatibility: unknown = Reflect.get(options, 'compatibility')
	return compatibility === undefined ? {} : { compatibility }
}

function isPublicAccess(access: unknown): boolean {
	return typeof access === 'object' && access !== null && 'public' in access && access.public === true
}

/** Every procedure of a tree with its dotted path. */
function procedureEntries(tree: ProcedureTreeDeclaration<Schema>, prefix = ''): [string, ProcedureDeclaration<Schema>][] {
	return Object.entries(tree).flatMap(([name, node]): [string, ProcedureDeclaration<Schema>][] => {
		const path = prefix === '' ? name : `${prefix}.${name}`
		return isProcedure(node) ? [[path, node]] : procedureEntries(node, path)
	})
}

function isGroup(value: MountedGroupsValue): value is GroupDeclaration {
	return value['~kind'] === 'group'
}

function isRuntimeGroup(value: GroupDeclaration): value is RuntimeGroup {
	return 'unknownOptions' in value && Array.isArray(value.unknownOptions)
}

function mountedGroups(value: MountedGroupsValue): GroupDeclaration[] {
	if (typeof value !== 'object' || value === null) {
		throw new ContractError([`c.rpc: ${String(value)} is not a group (allowed: app.group(…), or { <name>: <group> })`])
	}
	if (isGroup(value)) {
		return [value]
	}
	return Object.values(value).flatMap(mountedGroups)
}

function mountedProcedures(value: MountedGroupsValue): ProcedureTreeDeclaration<Schema> {
	if (isGroup(value)) {
		return value.endpoints
	}
	return Object.fromEntries(Object.entries(value).map(([name, nested]) => [name, mountedProcedures(nested)]))
}

const sameCallers = (left: readonly string[], right: readonly string[]): boolean =>
	left.length === right.length && left.every((caller, index) => caller === right[index])

function importDeclarations(imports: KitImports): Record<string, KitImportDeclaration> {
	return Object.fromEntries(
		Object.entries(imports).map(([name, imported]) => [name, {
			app: imported.snapshot.app,
			export: imported.snapshot.export,
			version: imported.snapshot.version,
			digest: imported.snapshot.digest,
			procedures: imported.procedures,
			timeoutMs: imported.timeoutMs,
		}]),
	)
}

/** One import of the kit as the contract records it: the snapshot's identity, the procedures called, the deadline. */
export interface KitImportDeclaration {
	readonly app: string
	readonly export: string
	readonly version: number
	readonly digest: string
	readonly procedures: readonly string[]
	readonly timeoutMs?: number
}

/**
 * The contract's `imports` section: each import of the kit, used by the RPC endpoints that declare `connect` of it,
 * in id order. The static reader builds it with this same function, so both read one `usedBy`.
 */
export function kitImportsSection(imports: Readonly<Record<string, KitImportDeclaration>>, surface: Surface): Record<string, ImportDeclaration> {
	const connecting = connectingEndpoints(surface)
	return Object.fromEntries(
		Object.entries(imports).map(([name, declaration]) => [name, {
			app: declaration.app,
			export: declaration.export,
			version: declaration.version,
			digest: declaration.digest,
			procedures: [...declaration.procedures],
			usedBy: connecting.filter((site) => site.connect.includes(name)).map((site) => site.id).sort(),
			...(declaration.timeoutMs === undefined ? {} : { timeoutMs: declaration.timeoutMs }),
		}]),
	)
}

/** Every procedure of an RPC mount that declares a `connect` list, by its id. */
function connectingEndpoints(surface: Surface): { readonly id: string; readonly connect: readonly unknown[] }[] {
	const found: { readonly id: string; readonly connect: readonly unknown[] }[] = []
	const visit = (tree: ProcedureTreeDeclaration<Schema>, prefix: string): void => {
		for (const [name, node] of Object.entries(tree)) {
			const id = `${prefix}.${name}`
			if (!isProcedure(node)) {
				visit(node, id)
			} else if (isRecord(node.declared) && Array.isArray(node.declared['connect'])) {
				found.push({ id, connect: node.declared['connect'] })
			}
		}
	}
	for (const [name, mount] of Object.entries(surface)) {
		if (typeof mount === 'object' && isRpcMount(mount)) {
			visit(mount.procedures, name)
		}
	}
	return found
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null && !Array.isArray(value)

function isRpcMount(value: object): value is RpcMountDeclaration<Schema> {
	return 'kind' in value && value.kind === 'rpc' && 'procedures' in value
}
