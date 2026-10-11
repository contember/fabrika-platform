// `defineApp(vocabulary, tables)`: the staged kit. The vocabulary knows nothing, the tables know the vocabulary, the
// kit knows both, and the groups and the contract know the kit; nothing types itself by `typeof contract`, so the
// handlers beside their endpoints, in any module, type-check without a cycle. Browser-safe: it imports types only.

import type { RpcCaller } from '@fabrika/auth-core'
import type { DbIndex, Tables, Unavailable, UnscopedDeclaration, UnscopedMode } from '@fabrika/db/tables'
import type { z } from 'zod/v4'
import type { Declared, JobKitContext, KitImports, KitTypes, SqlMode, WebhookKitContext } from './context'
import type { ExportAccessDeclaration, ImportDeclaration, LinkAccessDeclaration, ProcedureType } from './declaration'
import type {
	Contract,
	CreatableDimension,
	CronJob,
	Export,
	InputSchema,
	Kit,
	LinkMount,
	NotLoose,
	Path,
	ProcedureTree,
	RpcMount,
	Schema,
	Surface,
	WebhookMount,
} from './define'
import type { Endpoint, ExportKit, Group, GroupKit, GroupTree, LinkGroupKit } from './group'
import { notImplemented } from './problems'
import type { AnyAppVocabulary, AppVocabulary } from './vocabulary'

/** Fields a builder sets itself: an options object that carries one does not type-check. */
type Owned<K extends string> = { readonly [P in K]?: never }

/** The kit's types, computed once from the vocabulary, the tables' index and the imports. */
export type KitOf<V, Ix, Imp extends KitImports> = V extends AppVocabulary<infer A, infer D, infer R, infer Dims> ? {
		readonly action: A
		readonly dimension: D
		readonly creatable: CreatableDimension<Dims>
		readonly role: R
		readonly dimensions: Dims
		readonly index: Ix
		readonly tables: Ix extends { readonly tables: infer T } ? keyof T & string : never
		readonly imports: Imp
	}
	: never

export interface CronOptions<Acts, Sc, S, U> extends Owned<'kind' | 'schedule'> {
	readonly actions: Acts
	readonly scope: Sc
	readonly timeout?: string
	readonly retries?: number
	readonly sql?: S
	readonly unscoped?: U
}

/** A cron job of the kit, handled. */
export interface KitCronJob<Acts extends string, Sc extends string, D> extends CronJob<Acts, Sc> {
	readonly declared: D
}

/** A cron job before `.handle`: the contract's `jobs` refuses it. */
export interface CronBuilder<K extends KitTypes, Acts extends string, Sc extends string, D extends Declared<SqlMode, unknown, never, never>> {
	handle(handler: (args: { readonly ctx: JobKitContext<K, Acts, D> }) => void | Promise<void>): KitCronJob<Acts, Sc, D>
}

export interface WebhookOptions<B, Acts, I, S, U> extends Owned<'kind' | 'path'> {
	readonly scheme: 'github-sha256'
	readonly boundTo: B
	readonly actions: Acts
	readonly input: I & NotLoose<I>
	readonly maxBytes?: number
	readonly sql?: S
	readonly unscoped?: U
}

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
> {
	handle(
		handler: (args: { readonly input: z.output<I>; readonly ctx: WebhookKitContext<K, B, Acts, D> }) => void | Promise<void>,
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
	| Group<readonly [RpcCaller, ...RpcCaller[]], GroupTree>
	| { readonly [name: string]: MountedGroups }

type CallersOf<G> = G extends Group<infer C, GroupTree> ? C : { [K in keyof G]: CallersOf<G[K]> }[keyof G]
type EndpointsOf<G> = G extends Group<readonly [RpcCaller, ...RpcCaller[]], infer T> ? T : { readonly [K in keyof G]: EndpointsOf<G[K]> }

type Callers<G> = CallersOf<G> extends infer C extends readonly [RpcCaller, ...RpcCaller[]] ? C : never
type Endpoints<G> = EndpointsOf<G> extends infer T extends ProcedureTree ? T : never

type IsUnion<T, All = T> = T extends unknown ? ([All] extends [T] ? false : true) : never

/** One RPC mount serves one set of callers, so every group it mounts names the same callers, in the same order. */
type MountPrefix<G> = true extends IsUnion<CallersOf<G>> ? Unavailable<'every group of one RPC mount names the same callers, in the same order'>
	: Path

/** The builders of the contract's callback: the mounts that take no handler, and `rpc`, which mounts groups. */
export interface ContractKit<K extends KitTypes> extends Pick<Kit<K['action'], K['dimension'], K['creatable']>, 'spa' | 'health' | 'form' | 'files'> {
	/** The groups' endpoints at `POST <prefix>/<group>.<endpoint>`, to the callers the groups name. */
	rpc<const G extends MountedGroups>(
		prefix: MountPrefix<G>,
		groups: G,
	): RpcMount<Callers<G>, Endpoints<G>>
}

/** The `imports` section the contract carries: the kit's imports, with `usedBy` from the endpoints' `connect`. */
type ImportsSection<K extends KitTypes> = [keyof K['imports']] extends [never] ? unknown
	: { readonly imports: { readonly [N in keyof K['imports']]: ImportDeclaration } }

/** The contract `app.contract` returns: the same `Contract` the client, the compiler and the test kit read. */
export type KitContract<K extends KitTypes, S extends Surface> = Contract<
	K['action'],
	K['dimension'],
	K['role'],
	K['dimensions'],
	S & ImportsSection<K>
>

/** The kit of one application: every builder is typed by its vocabulary, its tables and its imports. */
export interface App<K extends KitTypes> {
	/** Endpoints for `callers`, declared and handled together; `fabrika.contract.ts` mounts the group with `c.rpc`. */
	group<const C extends readonly [RpcCaller, ...RpcCaller[]], const T extends GroupTree>(
		options: { readonly callers: C } & Owned<'kind' | 'endpoints'>,
		build: (r: GroupKit<K, C[number]>) => T,
	): Group<C, T>
	/** A cron job (UTC, five fields) holding `actions` in `scope`; the contract mounts it under `jobs`. */
	cron<
		const Acts extends readonly [K['action'], ...K['action'][]],
		const Sc extends K['dimension'] | 'app',
		const S extends SqlMode = never,
		const U extends UnscopedDeclaration<K['tables'], UnscopedMode> = never,
	>(schedule: string, options: CronOptions<Acts, Sc, S, U>): CronBuilder<K, Acts[number], Sc, Declared<S, U, never, never>>
	/** A GitHub webhook bound per value of `boundTo`; the contract mounts it by name. */
	webhook<
		const B extends K['dimension'],
		const Acts extends readonly [K['action'], ...K['action'][]],
		I extends InputSchema,
		const S extends SqlMode = never,
		const U extends UnscopedDeclaration<K['tables'], UnscopedMode> = never,
	>(path: Path, options: WebhookOptions<B, Acts, I, S, U>): WebhookBuilder<K, B, Acts[number], I, Declared<S, U, never, never>>
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
	/** The contract: mounts by name and the `files`, `jobs`, `exports` and `csp` sections; `imports` come from the kit. */
	contract<const S extends Surface & Owned<'imports'>>(build: (c: ContractKit<K>) => S): KitContract<K, S>
}

/**
 * The application's kit, built once in `src/app-kit.ts`: `defineApp(vocabulary, tables)`, plus the connectors it
 * imports (`{ imports: { <name>: { snapshot, procedures, timeoutMs? } } }`). The tables' `DbIndex` is computed here,
 * once, so each endpoint's `ctx.db` is a lookup.
 */
export function defineApp<V extends AnyAppVocabulary, DB, P, const Imp extends KitImports = Record<never, never>>(
	_vocabulary: V,
	_tables: Tables<DB, P>,
	_options?: { readonly imports?: Imp },
): App<KitOf<V, DbIndex<DB, P>, Imp>> {
	return notImplemented('defineApp', 'WU4')
}
