// What a handler of the staged kit receives. Types only, so the browser-safe contract can name them: every member
// is typed by the kit (vocabulary, `DbIndex`, imports) and the site's own declaration, never by the contract value,
// so a group in any module types itself without importing `fabrika.contract.ts`.

import type { RpcCaller } from '@fabrika/auth-core'
import type { AnyDbIndex, DataKind, NoUnscoped, ReferenceTables, ScopeTarget, Unavailable, UnscopedTables, WithinTables } from '@fabrika/db/tables'
import type { z } from 'zod/v4'
import type { Ref, Within } from '../implement/capability'
import type { LinkIssuing, MemberManagement } from '../implement/membership'
import type { AppPrincipal, PrincipalOf, ServicePrincipal } from '../implement/principal'
import type { ConnectCall, RequestContext } from '../implement/types'
import type { WebhookDelivery, WebhookPrincipal } from '../implement/webhook'
import type { JobContext } from '../jobs/types'
import type { ConnectSnapshot } from './connect'
import type { MemberAccess, Schema } from './define'

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
	readonly index: AnyDbIndex
	/** The table names of `src/db/tables.ts`. */
	readonly tables: string
	readonly imports: KitImports
}

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
export type SqlTag = <Row extends Schema>(row: Row) => (text: TemplateStringsArray, ...values: readonly SqlValue[]) => Promise<z.output<Row>[]>

type SqlContext<S> = {
	readonly sql: [S] extends [never] ? Unavailable<"ctx.sql needs a declaration: add sql: 'read' (or 'write' on a mutation) to this site">
		: SqlTag
}

type UnscopedData<Ix extends AnyDbIndex, U> = { readonly unscoped: [U] extends [never] ? NoUnscoped : UnscopedTables<Ix, U> }

/** The capability an access form hands, and what the other forms do not have. */
export type CapabilityContext<Acc> = Acc extends MemberAccess ? {
		readonly target: Unavailable<'a member endpoint holds no capability: declare access with on or in for ctx.target'>
		readonly within: Unavailable<'a member endpoint holds no capability: declare access with over for ctx.within'>
	}
	: Acc extends { readonly action: infer A extends string; readonly over: infer D extends string } ? {
			readonly within: Within<D, A>
			readonly target: Unavailable<'an over endpoint holds ctx.within, the scopes it may list in: declare access with on or in for ctx.target'>
		}
	: Acc extends { readonly action: infer A extends string; readonly in: infer D extends string } ? { readonly target: Ref<D, A> }
	: Acc extends { readonly action: infer A extends string; readonly on: infer D extends string } ? { readonly target: Ref<D, A> }
	: Acc extends { readonly action: infer A extends string; readonly creates: infer D extends string } ? { readonly created: Ref<D, A> }
	: never

/** `ctx.db` by access form (the API matrix of `docs/reference/application-runtime.md`). */
type AccessData<Ix extends AnyDbIndex, K extends DataKind, Acc> = Acc extends MemberAccess ? {
		readonly target: Unavailable<'a member endpoint reaches no application data: declare access with on, in or over'>
	}
	: Acc extends { readonly action: infer A extends string; readonly over: infer D extends string } ? {
			readonly within: WithinTables<Ix, D, A>
			readonly target: Unavailable<'an over endpoint lists through ctx.db.within: declare access with on or in for ctx.db.target'>
		}
	: Acc extends { readonly action: infer A extends string; readonly in: infer D extends string } ? { readonly target: ScopeTarget<Ix, D, A, K, 'in'> }
	: Acc extends { readonly action: infer A extends string; readonly on: infer D extends string } ? { readonly target: ScopeTarget<Ix, D, A, K, 'on'> }
	: Acc extends { readonly action: infer A extends string; readonly creates: infer D extends string }
		? { readonly created: ScopeTarget<Ix, D, A, K, 'in'> }
	: never

/** `ctx.db` of an endpoint: its access form's handle, the reference tables, and the tables it declares unscoped. */
export type EndpointData<Ix extends AnyDbIndex, K extends DataKind, Acc, U> =
	& AccessData<Ix, K, Acc>
	& { readonly reference: ReferenceTables<Ix> }
	& UnscopedData<Ix, U>

/** The dimension and action of an access form that hands a `Ref` of an existing object or scope. */
type TargetOf<Acc> = Acc extends { readonly action: infer A extends string; readonly in: infer D extends string } ? readonly [D, A]
	: Acc extends { readonly action: infer A extends string; readonly on: infer D extends string } ? readonly [D, A]
	: never

type ManagerOf<K extends KitTypes, D extends string> = D extends keyof K['dimensions']
	? K['dimensions'][D] extends { readonly members: { readonly manage: infer M extends string } } ? M : never
	: never

/** `ctx.members`, only where the action is the target dimension's `members.manage`. */
type MembersContext<K extends KitTypes, Acc> = TargetOf<Acc> extends readonly [infer D extends string, infer A extends string]
	? [ManagerOf<K, D>] extends [never] ? { readonly members: Unavailable<`the dimension ${D} declares no members`> }
	: A extends ManagerOf<K, D> ? { readonly members: MemberManagement<D, A, K['role']> }
	: { readonly members: Unavailable<`ctx.members needs the action '${ManagerOf<K, D>}', which manages the members of ${D}`> }
	: { readonly members: Unavailable<'ctx.members needs access on or in a dimension, with the action that manages its members'> }

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
	& SqlContext<Of<D, 'sql'>>
	& { readonly db: EndpointData<K['index'], Kind, Acc, Of<D, 'unscoped'>> }

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
	& SqlContext<Of<D, 'sql'>>
	& { readonly db: EndpointData<K['index'], Kind, { readonly action: A; readonly on: LD; readonly from: string }, Of<D, 'unscoped'>> }

/** An export procedure runs read-only, for a consumer application: its capability and data, nothing that writes. */
export type ExportContext<K extends KitTypes, Acc, D extends Declared<'read', unknown, never, never>> =
	& RequestContext<ServicePrincipal | AppPrincipal>
	& CapabilityContext<Acc>
	& SqlContext<Of<D, 'sql'>>
	& { readonly db: EndpointData<K['index'], 'query', Acc, Of<D, 'unscoped'>> }

/** A capability a job or webhook minted or received, bound to the same handles an endpoint's access form gets. */
export interface CapabilityData<Ix extends AnyDbIndex, Kind extends DataKind> {
	on<const D extends string, const A extends string>(ref: Ref<D, A>): ScopeTarget<Ix, D, A, Kind, 'on'>
	in<const D extends string, const A extends string>(ref: Ref<D, A>): ScopeTarget<Ix, D, A, Kind, 'in'>
	over<const D extends string, const A extends string>(within: Within<D, A>): WithinTables<Ix, D, A>
}

type SiteData<Ix extends AnyDbIndex, Kind extends DataKind, U> =
	& CapabilityData<Ix, Kind>
	& { readonly reference: ReferenceTables<Ix> }
	& UnscopedData<Ix, U>

/** Reads only: a job writes inside `ctx.transaction`, where its lease fences every statement. */
type ReadOnlyUnscoped<U> = { readonly [T in keyof U]: 'read' }

/** The fenced transaction of a job attempt: writes and `tx.sql` commit only while the attempt holds its lease. */
export type JobTransaction<K extends KitTypes, D extends Declared<SqlMode, unknown, never, never>> =
	& { readonly db: SiteData<K['index'], 'mutation', Of<D, 'unscoped'>> }
	& SqlContext<Of<D, 'sql'>>

/** What a cron job's handler receives. Its reads run outside the transaction; every write runs in `ctx.transaction`. */
export type JobKitContext<K extends KitTypes, A extends string, D extends Declared<SqlMode, unknown, never, never>> =
	& JobContext<A, K['dimension']>
	& { readonly db: SiteData<K['index'], 'query', [Of<D, 'unscoped'>] extends [never] ? never : ReadOnlyUnscoped<Of<D, 'unscoped'>>> }
	& { readonly sql: Unavailable<'a job runs ctx.sql inside ctx.transaction((tx) => …), as tx.sql'> }
	& { transaction<R>(work: (tx: JobTransaction<K, D>) => Promise<R>): Promise<R> }

/** What a webhook delivery's handler receives: one transaction per delivery, idempotent by `ctx.delivery.key`. */
export type WebhookKitContext<K extends KitTypes, B extends string, Acts extends string, D extends Declared<SqlMode, unknown, never, never>> =
	& RequestContext<WebhookPrincipal>
	& { readonly refs: { readonly [A in Acts]: Ref<B, A> }; readonly delivery: WebhookDelivery }
	& SqlContext<Of<D, 'sql'>>
	& { readonly db: SiteData<K['index'], 'mutation', Of<D, 'unscoped'>> }
