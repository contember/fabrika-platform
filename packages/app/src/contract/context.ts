// What a handler of the staged kit receives. Types only, so the browser-safe contract can name them: every member
// is typed by the kit (vocabulary, `DbIndex`, imports) and the site's own declaration, never by the contract value,
// so a group in any module types itself without importing `fabrika.contract.ts`.

import type { JobMailer, RpcCaller } from '@fabrika/auth-core'
import type { RowRef } from '@fabrika/db/capability'
import type {
	AnyDbIndex,
	ApplicationTables,
	ClaimedRowHandle,
	DataKind,
	FragmentTable,
	NoUnscoped,
	PublicApplicationTables,
	ReferenceTables,
	ScopedApplicationTables,
	ScopeTarget,
	TargetForm,
	Unavailable,
	UnscopedTables,
	WithinTables,
} from '@fabrika/db/tables'
import type { z } from 'zod/v4'
import type { StoredFilesHandle, StoredFilesReadHandle } from '../files/handle'
import type { AppCapability, Ref, Within } from '../implement/capability'
import type { ApplicationDirectory, LinkIssuing, MemberDirectory, MemberLookup, MemberManagement } from '../implement/membership'
import type { AppPrincipal, PrincipalOf, PublicPrincipal, ServicePrincipal } from '../implement/principal'
import type { TerminalIdentification } from '../implement/terminals'
import type { CapabilityOf, ConnectCall, RequestContext } from '../implement/types'
import type { WebhookDelivery, WebhookPrincipal } from '../implement/webhook'
import type { AppMail, JobContext } from '../jobs/types'
import type { ConnectSnapshot } from './connect'
import type { MemberAccess, Schema } from './define'
import type { App } from './kit'
import type { TokenPurposes, TokenSigning } from './token'
import type { WebhookBindings } from './webhook-binding'

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
	/** Whether the vocabulary declares `terminal: { identify }`, which gives `ctx.terminals`. */
	readonly terminal: boolean
	readonly index: AnyDbIndex
	/** The table names of `src/db/tables.ts`. */
	readonly tables: string
	readonly imports: KitImports
	/** The token purposes of `defineApp`'s options, by purpose. */
	readonly tokens: TokenPurposes
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
export interface Declared<S extends SqlMode, U, Cn extends readonly string[], Is extends string, M extends JobMailer = never> {
	readonly sql?: S
	readonly unscoped?: U
	readonly connect?: Cn
	readonly issues?: Is
	readonly mailer?: M
}

/** One declared field, `never` when the site leaves it out. */
type Of<D, F extends keyof Declared<SqlMode, unknown, readonly string[], string, JobMailer>> = D extends { readonly [P in F]?: infer V }
	? Exclude<V, undefined>
	: never

export type SqlValue = string | number | boolean | bigint | Date | null | readonly (string | number)[]

/**
 * `ctx.sql(Row)\`select …\``: one statement, every interpolation a bound parameter, run in the invocation's
 * transaction; each row is parsed (snake_case → camelCase, `Date` → ISO text, then `Row`).
 */
export interface SqlTag<Ix extends AnyDbIndex = AnyDbIndex, M extends SqlMode = SqlMode> {
	<Row extends Schema>(row: Row): (text: TemplateStringsArray, ...values: readonly (SqlValue | SqlScope)[]) => Promise<z.output<Row>[]>
	/**
	 * The capability's whole predicate on `table`: the object's key and every link of its chain for a `Ref`, what
	 * `ctx.db.within` matches for a `Within`, every row for `ctx.app`. Interpolated as
	 * `where ${ctx.sql.scope(ctx.target, 'tasks', { alias: 't' })}`, its values are bound parameters. `alias` is the
	 * table's name in the statement (the table's own by default). `use` states what the statement does with the table:
	 * `'read'` (the default) needs an action the table reads with, `'update'` or `'delete'` (a `'write'` site only) that
	 * operation's action, checked when the fragment is built. The statement is not read for where the fragment stands:
	 * using it as stated is the author's and the approver's to check. A table the capability reaches for no use of this
	 * site is a type error here.
	 */
	scope<C extends Ref<string, string> | Within<string, string> | AppCapability<string>, T extends FragmentTable<Ix, C, M>>(
		capability: C,
		table: T,
		options?: SqlScopeOptions,
	): SqlScope
}

/**
 * The third argument of `ctx.sql.scope`: the table's alias in the statement, and what the statement does with it. A
 * `'read'` site's `ctx.sql` is refused `'update'` and `'delete'` at run time; a `'write'` site's stays assignable to it.
 */
export interface SqlScopeOptions {
	readonly alias?: string
	readonly use?: 'read' | 'update' | 'delete'
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

/** `ctx.files.put` and `.open` of the stored files: a put everywhere but in a query. */
type FilesContext<Ix, K extends DataKind | 'transaction'> = {
	readonly files: Ix extends NoTablesIndex ? Unavailable<'this application declares no tables, so it stores no files'>
		: K extends 'query' ? StoredFilesReadHandle
		: StoredFilesHandle
}

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

/** Every action several capabilities name. */
type CapabilityActions<C> = { [N in keyof C]: C[N] extends { readonly action: infer A extends string } ? A : never }[keyof C]

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
	: Acc extends { readonly capabilities: infer C } ? {
			readonly capabilities: { readonly [N in keyof C]: CapabilityOf<C[N]> }
			readonly target: Unavailable<'an endpoint of several capabilities holds each in ctx.capabilities.<name>'>
			readonly within: Unavailable<'an endpoint of several capabilities holds each in ctx.capabilities.<name>'>
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

type WithinData<Ix extends AnyDbIndex, D extends string, A extends string, K extends DataKind> = Reaching<
	Ix,
	WithinTables<Ix, D, A, K>,
	`over: '${D}'`,
	'over'
>

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
	: Acc extends { readonly capabilities: infer C } ?
			& CapabilityData<Ix, K, CapabilityActions<C>>
			& {
				readonly target: Unavailable<'an endpoint of several capabilities binds each: ctx.db.on(ctx.capabilities.<name>), .in or .over'>
				readonly within: Unavailable<'an endpoint of several capabilities binds each: ctx.db.on(ctx.capabilities.<name>), .in or .over'>
				readonly app: Unavailable<'an endpoint of several capabilities binds each: ctx.db.on(ctx.capabilities.<name>), .in or .over'>
			}
	: Acc extends { readonly action: infer A extends string; readonly over: infer D extends string } ? {
			readonly within: WithinData<Ix, D, A, K>
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

/** `ctx.terminals`, where the vocabulary declares the terminal identification page. */
type TerminalsContext<K extends KitTypes> = K['terminal'] extends true ? { readonly terminals: TerminalIdentification }
	: { readonly terminals: Unavailable<"the application declares no terminal: terminal: { identify: '/identify' } in the vocabulary"> }

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
	& TerminalsContext<K>
	& SqlContext<Of<D, 'sql'>, K['index']>
	& FilesContext<K['index'], Kind>
	& { readonly db: DataOf<K['index'], EndpointData<K['index'], Kind, Acc, Of<D, 'unscoped'>>> }
	& NoMail

type PublicOnly = 'a public procedure acts application-wide, as its own workload: ctx.app(<action>) and ctx.db.app(<action>)'

/**
 * What the handler of a public procedure receives: anyone called it, and it runs as the endpoint's own workload, holding
 * its declared actions `Acts` and nothing else. `ctx.app('<action>')` mints, and `ctx.db.app('<action>')` inserts and
 * reads under it; no other reach.
 */
export type PublicContext<K extends KitTypes, Kind extends DataKind, Acts extends string> =
	& RequestContext<PublicPrincipal>
	& {
		/** A capability of one of the procedure's declared actions, application-wide, bound to this request. */
		app<const A extends Acts>(action: A): AppCapability<A>
		readonly target: Unavailable<PublicOnly>
		readonly within: Unavailable<PublicOnly>
		readonly members: Unavailable<'a public procedure reaches no member directory'>
		readonly links: Unavailable<'a public procedure issues no share link'>
		readonly connect: Unavailable<'a public procedure calls no other application'>
		/** The stored files: a public mutation puts one, and both open one this request holds. */
		readonly files: Kind extends 'query' ? StoredFilesReadHandle : StoredFilesHandle
		readonly sql: Unavailable<'a public procedure reaches its actions only: it declares no sql'>
	}
	& TerminalsContext<K>
	& {
		readonly db: DataOf<
			K['index'],
			{
				app<const A extends Acts>(action: A): PublicApplicationTables<K['index'], A, Kind>
				readonly target: Unavailable<PublicOnly>
				readonly within: Unavailable<PublicOnly>
				readonly unscoped: Unavailable<'a public procedure reaches its actions only: it declares no unscoped'>
			}
		>
	}
	& NoMail

/**
 * `ctx.kick('<job>')` of a site that declares `kicks`: the job runs in the background after the site's transaction
 * committed, once however often it is kicked, and not at all on a rollback. `ctx.kick('<job>', { at })` runs it at `at`
 * instead. Either way the kick is a durable wake written in the site's transaction, and it carries nothing.
 */
export type KickContext<Ks> = [Ks] extends [never]
	? { readonly kick: Unavailable<"declare kicks: ['<cron job>'] on this site to kick a job after its commit"> }
	: Ks extends readonly (infer N extends string)[] ? { kick(job: N, options?: KickOptions): void }
	: never

/** When a kicked job runs: at `at`, a `Date`; without options, as soon as the site committed. */
export interface KickOptions {
	readonly at: Date
}

/** `ctx.tokens.sign('<purpose>', claims, { days })` of a site that declares `signs`: a token of one of those purposes. */
export type TokensContext<K extends KitTypes, Sg> = [Sg] extends [never]
	? { readonly tokens: Unavailable<"declare signs: ['<token purpose>'] on this site to sign its tokens"> }
	: Sg extends readonly (infer P extends string)[] ? { readonly tokens: TokenSigning<K['tokens'], P> }
	: never

/**
 * `ctx.webhooks('<webhook>')` of a mutation that declares `binds`: the webhook's bindings, on the value a capability of
 * this request names, written in the mutation's transaction.
 */
export type WebhooksContext<Bs> = [Bs] extends [never]
	? { readonly webhooks: Unavailable<"declare binds: '<webhook>' on this mutation to create and remove its bindings"> }
	: { webhooks(name: Bs): WebhookBindings }

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
	& NoMail

/** An export procedure runs read-only, for a consumer application: its capability and data, nothing that writes. */
export type ExportContext<K extends KitTypes, Acc, D extends Declared<'read', unknown, never, never>> =
	& RequestContext<ServicePrincipal | AppPrincipal>
	& CapabilityContext<Acc>
	& SqlContext<Of<D, 'sql'>, K['index']>
	& { readonly db: DataOf<K['index'], EndpointData<K['index'], 'query', Acc, Of<D, 'unscoped'>>> }
	& NoMail

/**
 * A capability a job or webhook minted or received, of one of its declared actions `Acts`, bound to the same handles
 * an endpoint's access form gets. A capability typed with several actions reads no column of another read action.
 */
export interface CapabilityData<Ix extends AnyDbIndex, Kind extends DataKind, Acts extends string> {
	on<const D extends string, const A extends Acts>(ref: Ref<D, A>): Target<Ix, D, A, Kind, 'on'>
	/** A row a claim leased (`row.ref`), finished inside `ctx.transaction`. */
	on<const T extends TableName<Ix>, const A extends Acts>(ref: RowRef<T, A>): ClaimedRowHandle<T, Ix['tables'][T], A, Kind>
	in<const D extends string, const A extends Acts>(ref: Ref<D, A>): Target<Ix, D, A, Kind, 'in'>
	over<const D extends string, const A extends Acts>(within: Within<D, A>): WithinData<Ix, D, A, Kind>
}

type SiteData<Ix extends AnyDbIndex, Kind extends DataKind, Acts extends string, U> =
	& CapabilityData<Ix, Kind, Acts>
	& { readonly reference: ReferenceTables<Ix> }
	& UnscopedData<Ix, U, Kind>

/**
 * `ctx.db.app('<action>')` of a workload site that acts application-wide (a job): the application tables of one of its
 * declared actions, over `ctx.app('<action>')`.
 */
export interface WorkloadAppData<Ix extends AnyDbIndex, Kind extends DataKind, Acts extends string> {
	app<const A extends Acts>(action: A): AppData<Ix, A, Kind>
}

/** The fenced transaction of a job attempt: writes and `tx.sql` commit only while the attempt holds its lease. */
export type JobTransaction<K extends KitTypes, A extends string, D extends Declared<SqlMode, unknown, never, string, JobMailer>> =
	& { readonly db: SiteData<K['index'], 'mutation', A, Of<D, 'unscoped'>> & WorkloadAppData<K['index'], 'mutation', A> }
	& SqlContext<Of<D, 'sql'>, K['index']>
	& FilesContext<K['index'], 'transaction'>
	& {
		/**
		 * `ctx.ref`, located in this transaction: an object it wrote is found before the commit, so the same transaction
		 * reaches the record it just created.
		 */
		ref<const Act extends A, const Dim extends K['dimension']>(action: Act, dimension: Dim, id: string): Promise<Ref<Dim, Act>>
	}

/**
 * `ctx.links` of a cron job that declares the link mount it issues (`issues: '<mount>'`): a link for an object the job
 * located with `ctx.ref(<the mount's issuedBy>, <its dimension>, id)`, and the revocation of a link it issued.
 */
type JobLinksContext<Dim extends string, A extends string, Is extends string> = [Is] extends [never]
	? { readonly links: Unavailable<"declare issues: '<link mount>' on this job to issue its share links"> }
	: { readonly links: LinkIssuing<Dim, A, Is> }

/** `ctx.mail` of a cron job that declares the transport it sends through (`mailer: 'installation' | 'own'`). */
type JobMailContext<M extends JobMailer> = [M] extends [never]
	? { readonly mail: Unavailable<"declare mailer: 'installation' or 'own' on this job to send mail"> }
	: { readonly mail: AppMail }

/** A send is external I/O that never rolls back, so only a job sends, from the outbox row an endpoint wrote. */
type NoMail = { readonly mail: Unavailable<"an endpoint sends no mail: write an outbox row and kick a job that declares mailer (kicks: ['<job>'])"> }

/** What a cron job's handler receives. Its reads run outside the transaction; every write runs in `ctx.transaction`. */
export type JobKitContext<K extends KitTypes, A extends string, D extends Declared<SqlMode, unknown, never, string, JobMailer>> =
	& JobContext<A, K['dimension']>
	& { readonly db: SiteData<K['index'], 'job', A, Of<D, 'unscoped'>> & WorkloadAppData<K['index'], 'job', A> }
	& { readonly sql: Unavailable<'a job runs ctx.sql inside ctx.transaction((tx) => …), as tx.sql'> }
	& FilesContext<K['index'], 'job'>
	& JobLinksContext<K['dimension'], A, Of<D, 'issues'>>
	& JobMailContext<Of<D, 'mailer'>>
	& { transaction<R>(work: (tx: JobTransaction<K, A, D>) => Promise<R>): Promise<R> }

type BoundToValue = 'a webhook bound to a dimension acts on its bound value: use ctx.refs and ctx.db.on(ref)'

/**
 * What a webhook delivery's handler receives: one transaction per delivery, idempotent by `ctx.delivery.key`. A webhook
 * bound to a dimension acts on its bound value through `ctx.refs`; one bound to `'app'` acts application-wide, as its
 * own workload: `ctx.app('<action>')` and `ctx.db.app('<action>')`.
 */
export type WebhookKitContext<K extends KitTypes, B extends string, Acts extends string, D extends Declared<SqlMode, unknown, never, never>> =
	& RequestContext<WebhookPrincipal>
	& { readonly delivery: WebhookDelivery }
	& ([B] extends ['app'] ? {
			/** A capability of one of the webhook's declared actions, application-wide, bound to this delivery. */
			app<const A extends Acts>(action: A): AppCapability<A>
			readonly refs: Unavailable<'a webhook bound to the application has no bound value: use ctx.app(<action>) and ctx.db.app(<action>)'>
		}
		: { readonly refs: { readonly [A in Acts]: Ref<B, A> }; readonly app: Unavailable<BoundToValue> })
	& SqlContext<Of<D, 'sql'>, K['index']>
	& {
		readonly db:
			& SiteData<K['index'], 'mutation', Acts, Of<D, 'unscoped'>>
			& ([B] extends ['app'] ? WorkloadAppData<K['index'], 'mutation', Acts> : { readonly app: Unavailable<BoundToValue> })
	}
	& {
		/** The stored files: a delivery puts one, and opens one it holds. */
		readonly files: StoredFilesHandle
	}
	& NoMail

type IndexOf<A> = A extends App<infer K> ? K['index'] : never

/**
 * The type of a `ctx.db` handle, for a function of `src/<slice>/queries.ts` that takes it as a parameter:
 * `DbHandle<typeof app, 'on', 'deal', 'deals.write', 'mutation'>` is `ctx.db.target` of a mutation `on` a deal with
 * `deals.write`, and `DbHandle<typeof app, 'over', 'org', 'crm.read'>` is `ctx.db.within` of a query `over` orgs.
 */
export type DbHandle<A, F extends TargetForm | 'over', D extends string, Act extends string, K extends DataKind = 'query'> = F extends TargetForm
	? Target<IndexOf<A>, D, Act, K, F>
	: WithinData<IndexOf<A>, D, Act, K>

/**
 * The type of `ctx.db.app` of an `app` endpoint, for a function of `src/<slice>/queries.ts` that takes it:
 * `AppHandle<typeof app, 'candidates.export', 'mutation'>`.
 */
export type AppHandle<A, Act extends string, K extends DataKind = 'query'> = AppData<IndexOf<A>, Act, K>

/** The type of `ctx.db.reference`, for a query function that takes it. */
export type ReferenceHandle<A> = ReferenceTables<IndexOf<A>>

/**
 * The type of `ctx.sql`, for a function of `src/<slice>/queries.ts` that takes it: `SqlHandle<typeof app, 'read'>`.
 * A `'write'` site's `ctx.sql` is assignable to it, and `sql.scope(capability, table)` checks the table against the
 * app's own tables.
 */
export type SqlHandle<A, M extends SqlMode> = SqlTag<IndexOf<A>, M>
