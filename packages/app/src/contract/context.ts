// What a handler of the staged kit receives. Types only, so the browser-safe contract can name them: every member
// is typed by the kit (vocabulary, `DbIndex`, imports) and the site's own declaration, never by the contract value,
// so a group in any module types itself without importing `fabrika.contract.ts`.

import type { RpcCaller } from '@fabrika/auth-core'
import type {
	AnyDbIndex,
	ApplicationTables,
	DataKind,
	FragmentTable,
	NoUnscoped,
	ReferenceTables,
	ScopedApplicationTables,
	ScopeTarget,
	TargetForm,
	Unavailable,
	UnscopedTables,
	WithinTables,
} from '@fabrika/db/tables'
import type { z } from 'zod/v4'
import type { FileCollectionHandle, FileCollectionReadHandle, FileCollections } from '../files/handle'
import type { AppCapability, Ref, Within } from '../implement/capability'
import type { ApplicationDirectory, LinkIssuing, MemberDirectory, MemberLookup, MemberManagement } from '../implement/membership'
import type { AppPrincipal, PrincipalOf, ServicePrincipal } from '../implement/principal'
import type { ConnectCall, RequestContext } from '../implement/types'
import type { WebhookDelivery, WebhookPrincipal } from '../implement/webhook'
import type { JobContext } from '../jobs/types'
import type { ConnectSnapshot } from './connect'
import type { MemberAccess, Schema } from './define'
import type { App } from './kit'

export type { Unavailable } from '@fabrika/db/tables'

/** One connector the kit imports: the vendored snapshot, the procedures this application calls, its deadline. */
export interface KitImport {
	readonly snapshot: ConnectSnapshot
	readonly procedures: readonly [string, ...string[]]
	readonly timeoutMs?: number
}

export type KitImports = { readonly [name: string]: KitImport }

/** Everything the kit knows, computed once by `defineApp`: the vocabulary's names, the tables' index, the imports. */
export interface KitTypes {
	readonly action: string
	readonly dimension: string
	/** The dimensions `creates` may target: top-level ones that declare a `creator` role. */
	readonly creatable: string
	readonly role: string
	/** The dimension definitions as written, for `ctx.members`. */
	readonly dimensions: unknown
	/** The actions of the application's own people, as written; `never` when the vocabulary declares none. */
	readonly members: { readonly manage: string; readonly list: string }
	readonly index: AnyDbIndex
	/** The table names of `src/db/tables.ts`. */
	readonly tables: string
	readonly imports: KitImports
}

/**
 * The index of a kit without tables, `defineApp(vocabulary)`: an application that holds no data of its own (on
 * Cloudflare, which has no data layer yet). Its handlers have no `ctx.db` and no `ctx.sql`.
 */
export interface NoTablesIndex {
	readonly '~noTables': true
	readonly tables: Record<never, never>
	readonly owner: Record<never, never>
	readonly children: Record<never, never>
	readonly listed: Record<never, never>
	readonly within: Record<never, never>
	readonly references: never
	readonly applications: never
	readonly records: never
}

/** `ctx.db` of a site: its handles, or, in a kit without tables, a message that there are none. */
type DataOf<Ix, Handles> = Ix extends NoTablesIndex ? Unavailable<'this application declares no tables: defineApp(vocabulary, tables) gives ctx.db'>
	: Handles

export type ImportOf<K extends KitTypes> = keyof K['imports'] & string

/** `sql: 'read' | 'write'`: `ctx.sql` exists only on a site that declares it; `'read'` runs read-only. */
export type SqlMode = 'read' | 'write'

/**
 * The off-road reach a site declares: part of the contract, read by Control, a review signal for the approver. A
 * field the site does not declare is absent.
 */
export interface Declared<S extends SqlMode, U, Cn extends readonly string[], Is extends string> {
	readonly sql?: S
	readonly unscoped?: U
	readonly connect?: Cn
	readonly issues?: Is
}

/** One declared field, `never` when the site leaves it out. */
type Of<D, F extends keyof Declared<SqlMode, unknown, readonly string[], string>> = D extends { readonly [P in F]?: infer V } ? Exclude<V, undefined>
	: never

export type SqlValue = string | number | boolean | bigint | Date | null | readonly (string | number)[]

/**
 * `ctx.sql(Row)\`select …\``: one statement, every interpolation a bound parameter, run in the invocation's
 * transaction; each row is parsed (snake_case → camelCase, `Date` → ISO text, then `Row`).
 */
export interface SqlTag<Ix extends AnyDbIndex = AnyDbIndex, M extends SqlMode = SqlMode> {
	<Row extends Schema>(row: Row): (text: TemplateStringsArray, ...values: readonly (SqlValue | SqlScope)[]) => Promise<z.output<Row>[]>
	/**
	 * The capability's whole predicate on `table` (`alias` its name in the statement, the table's by default): the
	 * object's key and every link of its chain for a `Ref`, what `ctx.db.within` matches for a `Within`, every row for
	 * `ctx.app`. Interpolated as `where ${ctx.sql.scope(ctx.target, 'tasks', 't')}`, its values are bound parameters.
	 * A table the capability reaches for no use of this site is a type error here; at run time the fragment on the
	 * statement's UPDATE or DELETE target needs that operation's action, and anywhere else an action the table reads
	 * with.
	 */
	scope<C extends Ref<string, string> | Within<string, string> | AppCapability<string>, T extends FragmentTable<Ix, C, M>>(
		capability: C,
		table: T,
		alias?: string,
	): SqlScope
}

declare const sqlScope: unique symbol

/** What `ctx.sql.scope(…)` builds: only the framework makes one, and only its own tag takes it. */
export interface SqlScope {
	readonly [sqlScope]: true
}

type SqlContext<S, Ix extends AnyDbIndex> = {
	readonly sql: [S] extends [never] ? Unavailable<"ctx.sql needs a declaration: add sql: 'read' (or 'write' on a mutation) to this site">
		: SqlTag<Ix, S & SqlMode>
}

/** `ctx.files(<collection>)`: removal where the site writes (a mutation, a job's transaction), reading everywhere. */
type FilesContext<Ix, K extends DataKind> = {
	readonly files: Ix extends NoTablesIndex ? Unavailable<'this application declares no tables, so it has no file collections'>
		: FileCollections<K extends 'mutation' ? FileCollectionHandle : FileCollectionReadHandle<RemovesIn<K>>>
}

type RemovesIn<K extends DataKind> = K extends 'job' ? 'a job removes files inside ctx.transaction((tx) => …), as tx.files'
	: 'a query reads only; remove files in a mutation'

type UnscopedData<Ix extends AnyDbIndex, U, K extends DataKind> = {
	readonly unscoped: [U] extends [never] ? NoUnscoped : UnscopedTables<Ix, U, K>
}

/** An access form the vocabulary refuses: the refusal is reported where the form is written. */
export interface InvalidAccess {
	readonly '~invalid': 'access'
}

type IsUnion<T, All = T> = T extends unknown ? ([All] extends [T] ? false : true) : never

/**
 * `Acc`, or `InvalidAccess` when it is a union: a written form is one object, so a union is the whole constraint the
 * compiler falls back to after refusing the form. The handler then names the refusal instead of every form.
 */
export type CheckedAccess<Acc> = true extends IsUnion<Acc> ? InvalidAccess : Acc

/** The capability an access form hands, and what the other forms do not have. */
export type CapabilityContext<Acc> = Acc extends InvalidAccess ? {
		readonly target: Unavailable<'the access form of this endpoint is refused where it is declared: fix it there'>
		readonly within: Unavailable<'the access form of this endpoint is refused where it is declared: fix it there'>
		readonly created: Unavailable<'the access form of this endpoint is refused where it is declared: fix it there'>
	}
	: Acc extends MemberAccess ? {
			readonly target: Unavailable<'a member endpoint holds no capability: declare access with on or in for ctx.target'>
			readonly within: Unavailable<'a member endpoint holds no capability: declare access with over for ctx.within'>
		}
	: Acc extends { readonly action: infer A extends string; readonly over: infer D extends string } ? {
			readonly within: Within<D, A>
			readonly target: Unavailable<'an over endpoint holds ctx.within, the scopes it may list in: declare access with on or in for ctx.target'>
		}
	: Acc extends { readonly action: infer A extends string; readonly app: true } ? {
			readonly app: AppCapability<A>
			readonly target: Unavailable<'an app endpoint holds ctx.app, its action application-wide: declare access with on or in for ctx.target'>
			readonly within: Unavailable<'an app endpoint holds ctx.app, its action application-wide: declare access with over for ctx.within'>
		}
	: Acc extends { readonly action: infer A extends string; readonly in: infer D extends string } ? { readonly target: Ref<D, A> }
	: Acc extends { readonly action: infer A extends string; readonly on: infer D extends string } ? { readonly target: Ref<D, A> }
	: Acc extends { readonly action: infer A extends string; readonly creates: infer D extends string } ? { readonly created: Ref<D, A> }
	: never

type TableName<Ix extends AnyDbIndex> = keyof Ix['tables'] & string
type TableOf<Ix extends AnyDbIndex, T> = T extends TableName<Ix> ? Ix['tables'][T] : never

/** Where a table lies. */
type Lies<Ix extends AnyDbIndex, T extends string> = TableOf<Ix, T>['mode'] extends 'child' ? `it is a child of ${TableOf<Ix, T>['parent']}`
	: `it lies in ${TableOf<Ix, T>['list']}`

/** The access form that reaches a table: its parent's object for a child, else the dimension it lies in. */
type Reach<Ix extends AnyDbIndex, T extends string, Form extends 'target' | 'over'> = TableOf<Ix, T>['mode'] extends 'child'
	? `declare access on: '${TableOf<Ix, TableOf<Ix, T>['parent']>['dimension']}'`
	: Form extends 'over' ? `declare over: '${TableOf<Ix, T>['list']}'`
	: TableOf<Ix, T>['list'] extends TableOf<Ix, T>['dimension'] ? `declare access on or in: '${TableOf<Ix, T>['list']}'`
	: `declare access in: '${TableOf<Ix, T>['list']}' or on: '${TableOf<Ix, T>['dimension']}'`

/** Why the handle `Where` holds no table `T`: one line that names the table, the access form, and the form that reaches it. */
type Unreached<Ix extends AnyDbIndex, T extends string, Where extends string, Form extends 'target' | 'over'> = T extends Ix['references']
	? Unavailable<`${T} is a reference table: read it through ctx.db.reference.${T}`>
	: TableOf<Ix, T>['mode'] extends 'inbox' ? Unavailable<`${T} is a form inbox, which no ctx.db handle reads`>
	: T extends Ix['applications']
		? Unavailable<`${T} is an application table: read it through ctx.db.app.${T}, or declare access: { action, app: true }`>
	: Unavailable<`${T} is not under ${Where} (${Lies<Ix, T>}): ${Reach<Ix, T, Form>}`>

/**
 * A handle with every other table of the application as a refusal, so `ctx.db.target.tasks` on a form that does not
 * reach `tasks` names the table and the form instead of printing the index.
 */
type Reaching<Ix extends AnyDbIndex, H, Where extends string, Form extends 'target' | 'over'> =
	& H
	& { readonly [T in Exclude<TableName<Ix>, keyof H>]: Unreached<Ix, T, Where, Form> }

type Target<Ix extends AnyDbIndex, D extends string, A extends string, K extends DataKind, F extends TargetForm> = Reaching<
	Ix,
	ScopeTarget<Ix, D, A, K, F>,
	`${F}: '${D}'`,
	'target'
>

type WithinData<Ix extends AnyDbIndex, D extends string, A extends string> = Reaching<Ix, WithinTables<Ix, D, A>, `over: '${D}'`, 'over'>

type AppData<Ix extends AnyDbIndex, A extends string, K extends DataKind> = Reaching<Ix, ApplicationTables<Ix, A, K>, 'app: true', 'over'>

/** `ctx.db.app` of an `on`, `in` or `over` endpoint: the application tables it reads; every other table names its handle. */
type ScopedAppData<Ix extends AnyDbIndex, A extends string> =
	& ScopedApplicationTables<Ix, A>
	& {
		readonly [T in Exclude<TableName<Ix>, Ix['applications']>]: Unavailable<
			`${T} is not an application table: a scoped endpoint's ctx.db.app reads application tables only`
		>
	}

/** `ctx.db` by access form (the API matrix of `docs/reference/application-runtime.md`). */
type AccessData<Ix extends AnyDbIndex, K extends DataKind, Acc> = Acc extends InvalidAccess ? {
		readonly target: Unavailable<'the access form of this endpoint is refused where it is declared: fix it there'>
		readonly within: Unavailable<'the access form of this endpoint is refused where it is declared: fix it there'>
		readonly created: Unavailable<'the access form of this endpoint is refused where it is declared: fix it there'>
	}
	: Acc extends MemberAccess ? {
			readonly target: Unavailable<'a member endpoint reaches no application data: declare access with on, in or over'>
		}
	: Acc extends { readonly action: infer A extends string; readonly over: infer D extends string } ? {
			readonly within: WithinData<Ix, D, A>
			readonly app: ScopedAppData<Ix, A>
			readonly target: Unavailable<'an over endpoint lists through ctx.db.within: declare access with on or in for ctx.db.target'>
		}
	: Acc extends { readonly action: infer A extends string; readonly app: true } ? {
			readonly app: AppData<Ix, A, K>
			readonly target: Unavailable<'an app endpoint reaches its data through ctx.db.app: declare access with on or in for ctx.db.target'>
			readonly within: Unavailable<'an app endpoint reaches its data through ctx.db.app: declare access with over for ctx.db.within'>
		}
	: Acc extends { readonly action: infer A extends string; readonly in: infer D extends string }
		? { readonly target: Target<Ix, D, A, K, 'in'>; readonly app: ScopedAppData<Ix, A> }
	: Acc extends { readonly action: infer A extends string; readonly on: infer D extends string }
		? { readonly target: Target<Ix, D, A, K, 'on'>; readonly app: ScopedAppData<Ix, A> }
	: Acc extends { readonly action: infer A extends string; readonly creates: infer D extends string } ? { readonly created: Target<Ix, D, A, K, 'in'> }
	: never

/** `ctx.db` of an endpoint: its access form's handle, the reference tables, and the tables it declares unscoped. */
export type EndpointData<Ix extends AnyDbIndex, K extends DataKind, Acc, U> =
	& AccessData<Ix, K, Acc>
	& { readonly reference: ReferenceTables<Ix> }
	& UnscopedData<Ix, U, K>

/** The dimension and action of an access form that hands a `Ref` of an existing object or scope. */
type TargetOf<Acc> = Acc extends { readonly action: infer A extends string; readonly in: infer D extends string } ? readonly [D, A]
	: Acc extends { readonly action: infer A extends string; readonly on: infer D extends string } ? readonly [D, A]
	: never

type MembersOf<K extends KitTypes, D extends string> = D extends keyof K['dimensions']
	? K['dimensions'][D] extends { readonly members: { readonly manage: infer M extends string; readonly list: infer L extends string } }
		? { readonly manage: M; readonly list: L }
	: never
	: never

/** The nearest dimension, `D` or one containing it, that declares members; `never` when none does. */
type DirectoryOf<K extends KitTypes, D extends string> = [MembersOf<K, D>] extends [never]
	? D extends keyof K['dimensions'] ? K['dimensions'][D] extends { readonly in: infer P extends string } ? DirectoryOf<K, P> : never : never
	: D

/** A member's label in the directory of `N`: IAM answers one to every caller where `N` declares `directory: 'labels'`. */
type LabelOf<K extends KitTypes, N extends string> = N extends keyof K['dimensions']
	? K['dimensions'][N] extends { readonly directory: 'labels' } ? string : string | null
	: string | null

/** `ctx.members` below a directory `N`: the list where the action is its `members.list`, the lookup of one member everywhere. */
type DirectoryContext<K extends KitTypes, N extends string, A extends string> = A extends MembersOf<K, N>['list']
	? { readonly members: MemberDirectory<LabelOf<K, N>> }
	: {
		readonly members:
			& MemberLookup<LabelOf<K, N>>
			& { readonly list: Unavailable<`listing the members of ${N} needs the action '${MembersOf<K, N>['list']}'; get(principalId) checks one`> }
	}

/**
 * `ctx.members` of an endpoint on or in a dimension: management where the action is that dimension's `members.manage`;
 * otherwise the directory of the nearest dimension, its own or one containing it, that declares members. IAM checks the
 * endpoint's own action for a lookup and `members.list` for a list, so the type promises what IAM answers.
 */
type MembersContext<K extends KitTypes, Acc> = Acc extends { readonly action: infer A extends string; readonly app: true }
	? ApplicationMembersContext<K, A>
	: TargetOf<Acc> extends readonly [infer D extends string, infer A extends string]
		? A extends MembersOf<K, D>['manage'] ? { readonly members: MemberManagement<D, A, K['role']> }
		: [DirectoryOf<K, D>] extends [never] ? { readonly members: Unavailable<`neither ${D} nor a dimension containing it declares members`> }
		: DirectoryContext<K, DirectoryOf<K, D>, A>
	: { readonly members: Unavailable<'ctx.members needs access on or in a dimension, with the action that lists or manages its members'> }

/** `ctx.members` of an `app: true` endpoint: the application's own people, where its action is their `members.list`. */
type ApplicationMembersContext<K extends KitTypes, A extends string> = [K['members']] extends [never]
	? { readonly members: Unavailable<'the application declares no people: members: { manage, list } in the vocabulary'> }
	: A extends K['members']['list'] ? { readonly members: ApplicationDirectory }
	: { readonly members: Unavailable<`listing the application's people needs the action '${K['members']['list']}'`> }

/** `ctx.links`, only where the endpoint declares the link mount it issues (`issues: '<mount>'`). */
type LinksContext<Acc, Is extends string> = [Is] extends [never]
	? { readonly links: Unavailable<"declare issues: '<link mount>' on this endpoint to issue its share links"> }
	: TargetOf<Acc> extends readonly [infer D extends string, infer A extends string] ? { readonly links: LinkIssuing<D, A, Is> }
	: { readonly links: Unavailable<'a share link is bound to one object: declare access with on or in'> }

type ConnectorOf<I> = I extends { readonly snapshot: infer S; readonly procedures: readonly (infer P extends string)[] } ? {
		readonly [Path in P]: S extends
			{ readonly procedures: { readonly [Q in Path]: { readonly input: infer In; readonly output: infer O extends Schema } } } ? ConnectCall<In, O>
			: Unavailable<`the snapshot has no procedure ${Path}`>
	}
	: never

/** `ctx.connect`, with the connectors the endpoint declares (`connect: ['<connector>']`). */
type ConnectContext<K extends KitTypes, Cn extends readonly string[]> = [Cn] extends [never]
	? { readonly connect: Unavailable<"declare connect: ['<connector>'] on this endpoint to call another application"> }
	: { readonly connect: { readonly [N in Cn[number]]: ConnectorOf<K['imports'][N]> } }

/** What the handler of an RPC endpoint receives, for mount callers `Caller`, kind `Kind` and its declaration. */
export type EndpointContext<
	K extends KitTypes,
	Caller extends RpcCaller,
	Kind extends DataKind,
	Acc,
	D extends Declared<SqlMode, unknown, readonly string[], string>,
> =
	& RequestContext<PrincipalOf<Caller>>
	& CapabilityContext<Acc>
	& MembersContext<K, Acc>
	& LinksContext<Acc, Of<D, 'issues'>>
	& ConnectContext<K, Of<D, 'connect'>>
	& SqlContext<Of<D, 'sql'>, K['index']>
	& FilesContext<K['index'], Kind>
	& { readonly db: DataOf<K['index'], EndpointData<K['index'], Kind, Acc, Of<D, 'unscoped'>>> }

/** A link procedure acts on the one object its key is bound to. */
export type LinkContext<
	K extends KitTypes,
	Kind extends DataKind,
	LD extends string,
	A extends string,
	D extends Declared<SqlMode, unknown, never, never>,
> =
	& RequestContext<PrincipalOf<'link'>>
	& { readonly target: Ref<LD, A> }
	& SqlContext<Of<D, 'sql'>, K['index']>
	& FilesContext<K['index'], Kind>
	& {
		readonly db: DataOf<K['index'], EndpointData<K['index'], Kind, { readonly action: A; readonly on: LD; readonly from: string }, Of<D, 'unscoped'>>>
	}

/** An export procedure runs read-only, for a consumer application: its capability and data, nothing that writes. */
export type ExportContext<K extends KitTypes, Acc, D extends Declared<'read', unknown, never, never>> =
	& RequestContext<ServicePrincipal | AppPrincipal>
	& CapabilityContext<Acc>
	& SqlContext<Of<D, 'sql'>, K['index']>
	& { readonly db: DataOf<K['index'], EndpointData<K['index'], 'query', Acc, Of<D, 'unscoped'>>> }

/**
 * A capability a job or webhook minted or received, of one of its declared actions `Acts`, bound to the same handles
 * an endpoint's access form gets. A capability typed with several actions reads no column of another read action.
 */
export interface CapabilityData<Ix extends AnyDbIndex, Kind extends DataKind, Acts extends string> {
	on<const D extends string, const A extends Acts>(ref: Ref<D, A>): Target<Ix, D, A, Kind, 'on'>
	in<const D extends string, const A extends Acts>(ref: Ref<D, A>): Target<Ix, D, A, Kind, 'in'>
	over<const D extends string, const A extends Acts>(within: Within<D, A>): WithinData<Ix, D, A>
}

type SiteData<Ix extends AnyDbIndex, Kind extends DataKind, Acts extends string, U> =
	& CapabilityData<Ix, Kind, Acts>
	& { readonly reference: ReferenceTables<Ix> }
	& UnscopedData<Ix, U, Kind>

/** The fenced transaction of a job attempt: writes and `tx.sql` commit only while the attempt holds its lease. */
export type JobTransaction<K extends KitTypes, A extends string, D extends Declared<SqlMode, unknown, never, string>> =
	& { readonly db: SiteData<K['index'], 'mutation', A, Of<D, 'unscoped'>> }
	& SqlContext<Of<D, 'sql'>, K['index']>
	& FilesContext<K['index'], 'mutation'>

/**
 * `ctx.links` of a cron job that declares the link mount it issues (`issues: '<mount>'`): a link for an object the job
 * located with `ctx.ref(<the mount's issuedBy>, <its dimension>, id)`, and the revocation of a link it issued.
 */
type JobLinksContext<Dim extends string, A extends string, Is extends string> = [Is] extends [never]
	? { readonly links: Unavailable<"declare issues: '<link mount>' on this job to issue its share links"> }
	: { readonly links: LinkIssuing<Dim, A, Is> }

/** What a cron job's handler receives. Its reads run outside the transaction; every write runs in `ctx.transaction`. */
export type JobKitContext<K extends KitTypes, A extends string, D extends Declared<SqlMode, unknown, never, string>> =
	& JobContext<A, K['dimension']>
	& { readonly db: SiteData<K['index'], 'job', A, Of<D, 'unscoped'>> }
	& { readonly sql: Unavailable<'a job runs ctx.sql inside ctx.transaction((tx) => …), as tx.sql'> }
	& FilesContext<K['index'], 'job'>
	& JobLinksContext<K['dimension'], A, Of<D, 'issues'>>
	& { transaction<R>(work: (tx: JobTransaction<K, A, D>) => Promise<R>): Promise<R> }

/** What a webhook delivery's handler receives: one transaction per delivery, idempotent by `ctx.delivery.key`. */
export type WebhookKitContext<K extends KitTypes, B extends string, Acts extends string, D extends Declared<SqlMode, unknown, never, never>> =
	& RequestContext<WebhookPrincipal>
	& { readonly refs: { readonly [A in Acts]: Ref<B, A> }; readonly delivery: WebhookDelivery }
	& SqlContext<Of<D, 'sql'>, K['index']>
	& { readonly db: SiteData<K['index'], 'mutation', Acts, Of<D, 'unscoped'>> }

type IndexOf<A> = A extends App<infer K> ? K['index'] : never

/**
 * The type of a `ctx.db` handle, for a function of `src/<slice>/queries.ts` that takes it as a parameter:
 * `DbHandle<typeof app, 'on', 'deal', 'deals.write', 'mutation'>` is `ctx.db.target` of a mutation `on` a deal with
 * `deals.write`, and `DbHandle<typeof app, 'over', 'org', 'crm.read'>` is `ctx.db.within` of a query `over` orgs.
 */
export type DbHandle<A, F extends TargetForm | 'over', D extends string, Act extends string, K extends DataKind = 'query'> = F extends TargetForm
	? Target<IndexOf<A>, D, Act, K, F>
	: WithinData<IndexOf<A>, D, Act>

/**
 * The type of `ctx.db.app` of an `app` endpoint, for a function of `src/<slice>/queries.ts` that takes it:
 * `AppHandle<typeof app, 'candidates.export', 'mutation'>`.
 */
export type AppHandle<A, Act extends string, K extends DataKind = 'query'> = AppData<IndexOf<A>, Act, K>

/** The type of `ctx.db.reference`, for a query function that takes it. */
export type ReferenceHandle<A> = ReferenceTables<IndexOf<A>>
