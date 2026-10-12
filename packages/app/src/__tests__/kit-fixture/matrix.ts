// The staged kit's types, pinned: the access form → `ctx.db` mapping of the API matrix, the declared off-road fields,
// exact handled endpoints and the contract the kit composes. Part of the package typecheck; `kit-types.test.ts`
// compiles this directory again and expects no diagnostic.

import type { createClient } from '@fabrika/app/client'
import type {
	AnyContract,
	App,
	Declared,
	Endpoint,
	EndpointContext,
	JobKitContext,
	KitTypes,
	SqlTag,
	Unavailable,
	WebhookKitContext,
} from '@fabrika/app/contract'
import type { ConnectResult, DirectoryMember, LinkIssuing, MemberDirectory, MemberManagement, Ref, Within } from '@fabrika/app/implement'
import type { DbIndex, ScopeTarget, Tables } from '@fabrika/db/tables'
import type { contract } from './fabrika.contract'
import type { app } from './src/app-kit'
import type { DB } from './src/db/schema.generated'
import type { tables } from './src/db/tables'
import type { deals } from './src/deals/endpoints'
import type { ById, Deal } from './src/schemas'

type Equal<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

type K = typeof app extends App<infer Kit extends KitTypes> ? Kit : never
type None = Declared<never, never, never, never>
type Returned<F> = F extends (...args: never[]) => Promise<infer R> ? R : never
type Context<Kind extends 'query' | 'mutation', Acc, D extends Declared<'read' | 'write', unknown, readonly string[], string> = None> =
	EndpointContext<K, 'human', Kind, Acc, D>

type DealRow = {
	id: string
	company_id: string
	org_id: string
	title: string
	stage: 'lead' | 'proposal' | 'won' | 'lost'
	created_by: string
	version: number
}
type Flat<T> = { [P in keyof T]: T[P] }
/** The tables a handle reaches: every other table is an `Unavailable` that names the form that reaches it. */
type Reached<H> = { [P in keyof H]: H[P] extends Unavailable<string> ? never : P }[keyof H]
type DealRowWithMargin = DealRow & { margin: number | null }

type OnQuery = Context<'query', { readonly action: 'crm.read'; readonly on: 'deal'; readonly from: 'id' }>
type OnMutation = Context<'mutation', { readonly action: 'deals.write'; readonly on: 'deal'; readonly from: 'id' }>
type InMutation = Context<'mutation', { readonly action: 'crm.write'; readonly in: 'org'; readonly from: 'orgId' }>
type OverQuery = Context<'query', { readonly action: 'crm.read'; readonly over: 'org' }>
type OverCompany = Context<'query', { readonly action: 'crm.read'; readonly over: 'company' }>
type MemberQuery = Context<'query', { readonly member: true }>
type Creates = Context<'mutation', { readonly action: 'orgs.create'; readonly creates: 'org' }>
type Manages = Context<'mutation', { readonly action: 'members.manage'; readonly in: 'org'; readonly from: 'orgId' }>
type OffRoad = Context<
	'query',
	{ readonly action: 'crm.read'; readonly in: 'org'; readonly from: 'orgId' },
	Declared<'read', { readonly companies: 'read' }, readonly ['catalog'], never>
>
type Issues = Context<
	'mutation',
	{ readonly action: 'deals.share'; readonly on: 'deal'; readonly from: 'id' },
	Declared<never, never, never, 'shared'>
>

/** The API matrix: what each access form puts on `ctx` and `ctx.db`, and what it refuses with a message. */
export type Matrix = [
	// on, query: the target's row without a column of another read action; its child tables; no write, no lock.
	Expect<Equal<OnQuery['target'], Ref<'deal', 'crm.read'>>>,
	Expect<Equal<Flat<Returned<OnQuery['db']['target']['get']>>, DealRow>>,
	Expect<
		Equal<
			OnQuery['db']['target']['getForUpdate'],
			Unavailable<'getForUpdate locks the row, so it runs only in a mutation: declare the endpoint with r.mutation'>
		>
	>,
	Expect<Equal<OnQuery['db']['target']['update'], Unavailable<'update writes, so it runs only in a mutation: declare the endpoint with r.mutation'>>>,
	Expect<Equal<Returned<OnQuery['db']['target']['deal_activities']['get']>['body'], string>>,
	Expect<
		Equal<
			OnQuery['db']['target']['deal_activities']['insert'],
			Unavailable<'insert writes, so it runs only in a mutation: declare the endpoint with r.mutation'>
		>
	>,
	// on, mutation: the capability's own action reads its column; a precondition read under a lock; writes by action.
	Expect<Equal<Flat<Returned<OnMutation['db']['target']['get']>>, Flat<DealRowWithMargin>>>,
	Expect<Equal<Flat<Returned<OnMutation['db']['target']['getForUpdate']>>, Flat<DealRowWithMargin>>>,
	Expect<Equal<Parameters<OnMutation['db']['target']['update']>[1], { readonly expectVersion: number }>>,
	Expect<Equal<Returned<OnMutation['db']['target']['update']>, { readonly id: string; readonly version: number }>>,
	Expect<
		Equal<OnMutation['db']['target']['remove'], Unavailable<"delete on deals needs the action 'crm.delete', and this endpoint holds 'deals.write'">>
	>,
	Expect<Equal<Returned<OnMutation['db']['target']['deal_activities']['insert']>, { readonly id: string }>>,
	// in: the container's row for an action its table names, and inserts into the tables it contains.
	Expect<
		Equal<
			InMutation['db']['target']['get'],
			Unavailable<"orgs does not name the action 'crm.write': read it from an endpoint whose action orgs names, or declare unscoped">
		>
	>,
	Expect<Equal<Parameters<InMutation['db']['target']['companies']['insert']>[0], { name: string }>>,
	Expect<Equal<InMutation['db']['target']['update'], Unavailable<'update acts on one object: declare access with on'>>>,
	// over: keyset lists, counts and aggregates of every table whose chain holds the dimension; no single target.
	Expect<Equal<Returned<OverQuery['db']['within']['companies']['list']>['items'][number]['name'], string>>,
	Expect<Equal<Reached<OverQuery['db']['within']>, 'orgs' | 'companies' | 'deals' | 'deal_activities'>>,
	Expect<Equal<OverQuery['within'], Within<'org', 'crm.read'>>>,
	Expect<Equal<Reached<OverCompany['db']['within']>, 'deals' | 'deal_activities'>>,
	// A table the form does not reach names itself, the form, and the form that reaches it.
	Expect<Equal<OverCompany['db']['within']['orgs'], Unavailable<"orgs is not under over: 'company' (it lies in org): declare over: 'org'">>>,
	Expect<Equal<OverQuery['db']['within']['countries'], Unavailable<'countries is a reference table: read it through ctx.db.reference.countries'>>>,
	Expect<Equal<Returned<OverCompany['db']['within']['deal_activities']['list']>['items'][number]['body'], string>>,
	Expect<
		Equal<
			OverQuery['target'],
			Unavailable<'an over endpoint holds ctx.within, the scopes it may list in: declare access with on or in for ctx.target'>
		>
	>,
	// member: no application data, only the reference tables.
	Expect<Equal<MemberQuery['db']['target'], Unavailable<'a member endpoint reaches no application data: declare access with on, in or over'>>>,
	Expect<Equal<Flat<Returned<MemberQuery['db']['reference']['countries']['list']>['items'][number]>, { code: string; name: string }>>,
	// creates: the new scope, its own row by the table's insert action, then in-style inserts into it.
	Expect<Equal<Creates['created'], Ref<'org', 'orgs.create'>>>,
	Expect<Equal<Parameters<Creates['db']['created']['orgs']['insert']>[0], { name: string }>>,
	Expect<Equal<Returned<Creates['db']['created']['orgs']['insert']>, { readonly id: string; readonly version: number }>>,
	Expect<
		Equal<
			InMutation['db']['target']['orgs']['insert'],
			Unavailable<"insert on orgs needs the action 'orgs.create', and this endpoint holds 'crm.write'">
		>
	>,
	Expect<Equal<OnMutation['db']['target']['orgs'], Unavailable<"orgs is not under on: 'deal' (it lies in org): declare access on or in: 'org'">>>,
	Expect<
		Equal<
			InMutation['db']['target']['deals'],
			Unavailable<"deals is not under in: 'org' (it lies in company): declare access in: 'company' or on: 'deal'">
		>
	>,
	Expect<
		Equal<
			InMutation['db']['target']['deal_activities'],
			Unavailable<"deal_activities is not under in: 'org' (it is a child of deals): declare access on: 'deal'">
		>
	>,
	Expect<
		Equal<
			Creates['db']['created']['companies']['insert'],
			Unavailable<"insert on companies needs the action 'crm.write', and this endpoint holds 'orgs.create'">
		>
	>,
	// ctx.members only where the action manages the dimension's members, or lists them (a read-only directory).
	Expect<Equal<Manages['members'], MemberManagement<'org', 'members.manage', 'starter' | 'viewer' | 'owner'>>>,
	Expect<Equal<OffRoad['members'], MemberDirectory>>,
	Expect<Equal<Returned<OffRoad['members']['list']>, readonly DirectoryMember[]>>,
	Expect<
		Equal<
			InMutation['members'],
			Unavailable<"ctx.members needs the action 'crm.read' (lists the members of org) or 'members.manage' (manages them)">
		>
	>,
	Expect<Equal<OnQuery['members'], Unavailable<'the dimension deal declares no members'>>>,
]

type Unscoped = Context<
	'mutation',
	{ readonly member: true },
	Declared<never, { readonly companies: 'write'; readonly deals: 'write' }, never, never>
>

/** The declared off-road fields: each handle exists only where the site declares it, in the declared mode. */
export type OffRoadFields = [
	// An unscoped insert has no capability to stamp containment from, so it takes the containment columns.
	Expect<Equal<Parameters<Unscoped['db']['unscoped']['companies']['insert']>[0], { name: string; org_id: string }>>,
	Expect<
		Equal<
			Parameters<Unscoped['db']['unscoped']['deals']['insert']>[0],
			{ title: string; stage: 'lead' | 'proposal' | 'won' | 'lost'; margin?: number | null; company_id: string; org_id: string }
		>
	>,
	Expect<Equal<OffRoad['sql'], SqlTag>>,
	Expect<Equal<OnQuery['sql'], Unavailable<"ctx.sql needs a declaration: add sql: 'read' (or 'write' on a mutation) to this site">>>,
	Expect<Equal<Returned<OffRoad['db']['unscoped']['companies']['get']>['org_id'], string>>,
	Expect<
		Equal<
			OffRoad['db']['unscoped']['companies']['insert'],
			Unavailable<"companies is declared unscoped: 'read', so insert needs unscoped: { companies: 'write' }">
		>
	>,
	Expect<Equal<OffRoad['db']['unscoped']['deals'], Unavailable<"deals is outside this site's scope: declare unscoped: { deals: 'read' } on it">>>,
	Expect<Equal<OnQuery['db']['unscoped'], Unavailable<"this site declares no unscoped table: add unscoped: { <table>: 'read' } to its declaration">>>,
	Expect<
		Equal<
			Returned<OffRoad['connect']['catalog']['get']>,
			ConnectResult<{ sku: string; name: string; price: number; tags: ('new' | 'sale')[]; note?: string | undefined } | null>
		>
	>,
	Expect<Equal<OnQuery['connect'], Unavailable<"declare connect: ['<connector>'] on this endpoint to call another application">>>,
	Expect<Equal<Issues['links'], LinkIssuing<'deal', 'deals.share', 'shared'>>>,
	Expect<Equal<OnQuery['links'], Unavailable<"declare issues: '<link mount>' on this endpoint to issue its share links">>>,
]

/** A capability whose action type was widened holds no single action provably: it reads no column of another action. */
type Widened = ScopeTarget<K['index'], 'deal', 'crm.read' | 'deals.write', 'query', 'on'>

type JobCtx = JobKitContext<K, 'crm.read' | 'deals.write', Declared<'write', never, never, never>>
type HookCtx = WebhookKitContext<K, 'org', 'crm.write', None>

/** Jobs read outside their fenced transaction and write inside it; a webhook delivery is one transaction. */
export type Sites = [
	Expect<Equal<Flat<Returned<Widened['get']>>, DealRow>>,
	Expect<Equal<JobCtx['sql'], Unavailable<'a job runs ctx.sql inside ctx.transaction((tx) => …), as tx.sql'>>>,
	Expect<Equal<Parameters<Parameters<JobCtx['transaction']>[0]>[0]['sql'], SqlTag>>,
	Expect<Equal<HookCtx['refs'], { readonly 'crm.write': Ref<'org', 'crm.write'> }>>,
]

type Get = typeof deals.endpoints.get
type Policies = typeof tables extends Tables<DB, infer P> ? P : never

/** `.handle` keeps the declaration and drops the handler; the index is the tables' once; the contract is a contract. */
export type Composition = [
	Expect<Equal<Get, Endpoint<'query', typeof ById, typeof Deal, { readonly action: 'crm.read'; readonly on: 'deal'; readonly from: 'id' }, None>>>,
	Expect<Equal<K['index'], DbIndex<DB, Policies>>>,
	Expect<Equal<typeof tables extends Tables<infer Rows, infer _Policies> ? Rows : never, DB>>,
	Expect<Equal<typeof contract extends AnyContract ? true : false, true>>,
	Expect<Equal<typeof contract.surface.api.callers, readonly ['human']>>,
	Expect<Equal<typeof contract.surface.api.procedures.deals.reopen.type, 'mutation'>>,
	Expect<Equal<keyof typeof contract.surface.api.procedures, 'deals' | 'companies'>>,
]

type Client = ReturnType<typeof createClient<typeof contract, 'api'>>

/** The SPA's client reads a kit contract like any other. */
export type ClientTypes = [
	Expect<Equal<Parameters<Client['deals']['get']>[0], { id: string }>>,
	Expect<Equal<Awaited<ReturnType<Client['deals']['reopen']>>, { id: string; version: number }>>,
]
