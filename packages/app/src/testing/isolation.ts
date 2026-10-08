// @fabrika/app/testing/isolation — the kit behind the tests `fabrika db test-scaffold` generates. It serves one table
// of the application through a probe contract over the application's own vocabulary, booted by `testKit`: every request takes the
// production path (the proxy decision, the token, the access form, the request-bound capability, the data layer's
// scope predicate) and only the handler is the kit's. Each attempt seeds two fresh rows that share no scope value
// and asks as a caller holding every action of the table in the scope of one of them.

import { scoped, type Tables } from '@fabrika/db'
import { tablePolicies } from '@fabrika/db/tables'
import { type IsolationWorlds, type SampleValue, tableProbe, type TestDatabase } from '@fabrika/db/testing'
import { z } from 'zod/v4'
import { createClient } from '../client/contract'
import { RpcError } from '../client/transport'
import { type AnyContract, defineContract, type Vocabulary } from '../contract/define'
import { implement } from '../implement/implement'
import type { TestGrant } from './caller'
import { testKit } from './kit'

/** Which of the two seeded rows a request names: the caller's own, or the one in the scope it holds nothing in. */
export type IsolationRow = 'own' | 'other'

/** A child row addressed through the caller's own parent with the other row's key: a key from another scope. */
export type ChildIsolationRow = IsolationRow | 'crossed'

export interface IsolationOutcome {
	/** 200 when the operation ran, otherwise the status the caller got. */
	readonly status: number
}

export interface ReadOutcome extends IsolationOutcome {
	/** The columns the row came back with. */
	readonly columns: readonly string[]
}

export interface ListOutcome extends IsolationOutcome {
	/** Which seeded rows the list reached. */
	readonly rows: readonly IsolationRow[]
}

export interface CountOutcome extends IsolationOutcome {
	readonly count: string
}

export interface MisuseOutcome extends IsolationOutcome {
	/** Whether the data layer refused the read capability (`CapabilityError`). */
	readonly refused: boolean
}

export interface IsolationKit {
	readonly table: string
	/** The dimension the caller's grants are scoped by. */
	readonly dimension: string
	get(row: ChildIsolationRow): Promise<ReadOutcome>
	/** Lists through a `Within` of the caller's scope. */
	list(): Promise<ListOutcome>
	/** A child table listed through the parent's `Ref`; the dimension table has no parent. */
	listByParent(row: IsolationRow): Promise<ListOutcome>
	count(): Promise<CountOutcome>
	insert(into: IsolationRow): Promise<IsolationOutcome>
	update(row: ChildIsolationRow): Promise<IsolationOutcome>
	remove(row: ChildIsolationRow): Promise<IsolationOutcome>
	/** A `Ref` for the read action handed to update: the data layer must refuse it. */
	updateWithRead(): Promise<MisuseOutcome>
	/** A `Ref` for the read action handed to remove. */
	removeWithRead(): Promise<MisuseOutcome>
}

const ById = z.strictObject({ id: z.string() })
const Edit = z.strictObject({ id: z.string(), tag: z.string() })
const InScope = z.strictObject({ scope: z.string(), tag: z.string() })
const ChildByKey = z.strictObject({ parent: z.string(), key: z.string() })
const ChildEdit = z.strictObject({ parent: z.string(), key: z.string(), tag: z.string() })
const ChildInsert = z.strictObject({ parent: z.string(), tag: z.string() })
const ByParent = z.strictObject({ parent: z.string() })
const Columns = z.strictObject({ columns: z.array(z.string()) })
const Keys = z.strictObject({ keys: z.array(z.string()) })
const Count = z.strictObject({ count: z.string() })
const Done = z.strictObject({ done: z.boolean() })
const Refused = z.strictObject({ refused: z.boolean() })

interface ProbeActions {
	readonly read: string
	readonly insert: string | null
	readonly update: string | null
	readonly delete: string | null
}

function isCapabilityError(error: unknown): boolean {
	return error instanceof Error && error.name === 'CapabilityError'
}

/** The status a refused request got, or the error when it was not an answer of the application. */
function statusOf(error: unknown): number {
	if (error instanceof RpcError && error.httpStatus !== undefined) {
		return error.httpStatus
	}
	throw error
}

async function attempt<T extends object>(run: () => Promise<T>, failed: (status: number) => T): Promise<T> {
	try {
		return await run()
	} catch (error) {
		return failed(statusOf(error))
	}
}

/** A write's outcome: 200 when it ran, the status otherwise. */
function wrote(run: () => Promise<unknown>): Promise<IsolationOutcome> {
	return attempt(async () => {
		await run()
		return { status: 200 }
	}, (status) => ({ status }))
}

function dimensionProbe(vocabulary: Vocabulary<string, string, string>, dimension: string, list: string, actions: ProbeActions) {
	const { read } = actions
	return defineContract(vocabulary, (c) => ({
		probe: c.rpc('/probe', { callers: ['human'] }, {
			get: c.query({ input: ById, output: Columns, access: { action: read, on: dimension, from: 'id' } }),
			list: c.query({ output: Keys, access: { action: read, over: list } }),
			count: c.query({ output: Count, access: { action: read, over: list } }),
			insert: c.mutation({ input: InScope, output: Done, access: { action: actions.insert ?? read, in: list, from: 'scope' } }),
			update: c.mutation({ input: Edit, output: Done, access: { action: actions.update ?? read, on: dimension, from: 'id' } }),
			remove: c.mutation({ input: ById, output: Done, access: { action: actions.delete ?? read, on: dimension, from: 'id' } }),
			updateWithRead: c.mutation({ input: Edit, output: Refused, access: { action: read, on: dimension, from: 'id' } }),
			removeWithRead: c.mutation({ input: ById, output: Refused, access: { action: read, on: dimension, from: 'id' } }),
		}),
	}))
}

function childProbe(vocabulary: Vocabulary<string, string, string>, parent: string, list: string, actions: ProbeActions) {
	const { read } = actions
	return defineContract(vocabulary, (c) => ({
		probe: c.rpc('/probe', { callers: ['human'] }, {
			get: c.query({ input: ChildByKey, output: Columns, access: { action: read, on: parent, from: 'parent' } }),
			list: c.query({ output: Keys, access: { action: read, over: list } }),
			listByParent: c.query({ input: ByParent, output: Keys, access: { action: read, on: parent, from: 'parent' } }),
			count: c.query({ output: Count, access: { action: read, over: list } }),
			insert: c.mutation({ input: ChildInsert, output: Done, access: { action: actions.insert ?? read, in: parent, from: 'parent' } }),
			update: c.mutation({ input: ChildEdit, output: Done, access: { action: actions.update ?? read, on: parent, from: 'parent' } }),
			remove: c.mutation({ input: ChildByKey, output: Done, access: { action: actions.delete ?? read, on: parent, from: 'parent' } }),
			updateWithRead: c.mutation({ input: ChildEdit, output: Refused, access: { action: read, on: parent, from: 'parent' } }),
			removeWithRead: c.mutation({ input: ChildByKey, output: Refused, access: { action: read, on: parent, from: 'parent' } }),
		}),
	}))
}

/**
 * The isolation kit of `table`, a dimension or child table of `tables`, over `postgres`. `contract` gives only the
 * vocabulary: its actions, dimensions and roles. The kit binds a data layer of its own, so it does not touch the
 * application's.
 */
export function isolationKit<C extends AnyContract, DB, P>(contract: C, tables: Tables<DB, P>, table: string, postgres: TestDatabase): IsolationKit {
	const policy = tablePolicies(tables)[table]
	if (policy === undefined) {
		throw new Error(`${table} is not a table of src/db/tables.ts`)
	}
	const scope = policy.scope
	if (scope.mode !== 'dimension' && scope.mode !== 'child') {
		throw new Error(`${table} is a ${scope.mode} table; no store reaches it, so it has no isolation tests`)
	}
	const actions: ProbeActions = policy.actions
	const layer = scoped(tables)
	const probe = tableProbe(layer, table)
	const expectVersion = policy.version === null ? undefined : 1
	const pending = new Map<string, Readonly<Record<string, SampleValue>>>()
	const valuesOf = (tag: string): Readonly<Record<string, SampleValue>> => {
		const values = pending.get(tag)
		pending.delete(tag)
		if (values === undefined) {
			throw new Error(`no values were staged for ${tag}`)
		}
		return values
	}
	const keysOf = (rows: readonly Readonly<Record<string, unknown>>[]): string[] => rows.map((row) => String(row[scope.key]))
	const tagged = (values: Readonly<Record<string, SampleValue>>): string => {
		const tag = crypto.randomUUID()
		pending.set(tag, values)
		return tag
	}
	const required = (operation: 'insert' | 'update' | 'delete'): void => {
		if (actions[operation] === null) {
			throw new Error(`the policy of ${table} declares no ${operation} action`)
		}
	}
	const misuse = async (run: () => Promise<unknown>): Promise<{ readonly refused: boolean }> => {
		try {
			await run()
			return { refused: false }
		} catch (error) {
			if (isCapabilityError(error)) {
				return { refused: true }
			}
			throw error
		}
	}
	const seed = (): Promise<IsolationWorlds> => postgres.seedWorlds(tables, table)
	const grantsIn = (worlds: IsolationWorlds): TestGrant<AnyContract>[] => {
		const held = new Set([actions.read, actions.insert, actions.update, actions.delete].filter((action) => action !== null))
		return [...held].map((action) => ({ action, scope: { type: worlds.dimension, value: worlds.own.scope } }))
	}

	if (scope.mode === 'dimension') {
		const dimension = scope.dimension
		const list = scope.container?.dimension ?? dimension
		const probeContract = dimensionProbe(contract.vocabulary, dimension, list, actions)
		const kit = testKit(
			implement(probeContract, {
				database: layer,
				deps: () => ({}),
				handlers: () => ({
					probe: {
						get: async ({ ctx }) => ({ columns: Object.keys(await probe.get(ctx.target)) }),
						list: async ({ ctx }) => ({ keys: keysOf(await probe.select(ctx.within)) }),
						count: async ({ ctx }) => ({ count: await probe.count(ctx.within) }),
						insert: async ({ input, ctx }) => {
							await probe.insert(ctx.target, valuesOf(input.tag))
							return { done: true }
						},
						update: async ({ input, ctx }) => {
							await probe.update(ctx.target, undefined, valuesOf(input.tag), expectVersion)
							return { done: true }
						},
						remove: async ({ ctx }) => {
							await probe.remove(ctx.target)
							return { done: true }
						},
						updateWithRead: ({ input, ctx }) => misuse(() => probe.update(ctx.target, undefined, valuesOf(input.tag), expectVersion)),
						removeWithRead: ({ ctx }) => misuse(() => probe.remove(ctx.target)),
					},
				}),
			}),
			{ database: postgres.database },
		)
		const session = (worlds: IsolationWorlds) => createClient(probeContract, 'probe', { fetch: kit.browser(kit.testCaller(grantsIn(worlds))) })
		const keyOf = (worlds: IsolationWorlds, row: ChildIsolationRow): string => {
			if (row === 'crossed') {
				throw new Error(`${table} is a dimension table; a crossed key addresses a child row`)
			}
			return worlds[row].key
		}
		const dimensionKit: IsolationKit = {
			table,
			dimension: list,
			async get(row) {
				const worlds = await seed()
				const api = session(worlds)
				return attempt(async () => ({ status: 200, ...(await api.get({ id: keyOf(worlds, row) })) }), (status) => ({ status, columns: [] }))
			},
			async list() {
				const worlds = await seed()
				const api = session(worlds)
				return attempt(async () => ({ status: 200, rows: reached(worlds, (await api.list()).keys) }), (status) => ({ status, rows: [] }))
			},
			listByParent() {
				return Promise.reject(new Error(`${table} is a dimension table; only a child table is listed by its parent`))
			},
			async count() {
				const api = session(await seed())
				return attempt(async () => ({ status: 200, ...(await api.count()) }), (status) => ({ status, count: '' }))
			},
			async insert(into) {
				required('insert')
				const worlds = await seed()
				const api = session(worlds)
				const tag = tagged(await postgres.sampleInsert(tables, table))
				return wrote(() => api.insert({ scope: worlds[into].scope, tag }))
			},
			async update(row) {
				required('update')
				const worlds = await seed()
				const api = session(worlds)
				const id = keyOf(worlds, row)
				const tag = tagged(worlds[row === 'other' ? 'other' : 'own'].updates)
				return wrote(() => api.update({ id, tag }))
			},
			async remove(row) {
				required('delete')
				const worlds = await seed()
				const api = session(worlds)
				return wrote(() => api.remove({ id: keyOf(worlds, row) }))
			},
			async updateWithRead() {
				const worlds = await seed()
				const api = session(worlds)
				const tag = tagged(worlds.own.updates)
				return attempt(
					async () => ({ status: 200, ...(await api.updateWithRead({ id: worlds.own.key, tag })) }),
					(status) => ({ status, refused: false }),
				)
			},
			async removeWithRead() {
				const worlds = await seed()
				const api = session(worlds)
				return attempt(async () => ({ status: 200, ...(await api.removeWithRead({ id: worlds.own.key })) }), (status) => ({ status, refused: false }))
			},
		}
		return Object.freeze(dimensionKit)
	}

	const parentPolicy = tablePolicies(tables)[scope.parent]
	if (parentPolicy?.scope.mode !== 'dimension') {
		throw new Error(`${table}: its parent ${scope.parent} is not a dimension table`)
	}
	const parent = parentPolicy.scope.dimension
	const list = parentPolicy.scope.container?.dimension ?? parent
	const probeContract = childProbe(contract.vocabulary, parent, list, actions)
	const kit = testKit(
		implement(probeContract, {
			database: layer,
			deps: () => ({}),
			handlers: () => ({
				probe: {
					get: async ({ input, ctx }) => ({ columns: Object.keys(await probe.get(ctx.target, input.key)) }),
					list: async ({ ctx }) => ({ keys: keysOf(await probe.select(ctx.within)) }),
					listByParent: async ({ ctx }) => ({ keys: keysOf(await probe.select(ctx.target)) }),
					count: async ({ ctx }) => ({ count: await probe.count(ctx.within) }),
					insert: async ({ input, ctx }) => {
						await probe.insert(ctx.target, valuesOf(input.tag))
						return { done: true }
					},
					update: async ({ input, ctx }) => {
						await probe.update(ctx.target, input.key, valuesOf(input.tag), expectVersion)
						return { done: true }
					},
					remove: async ({ input, ctx }) => {
						await probe.remove(ctx.target, input.key)
						return { done: true }
					},
					updateWithRead: ({ input, ctx }) => misuse(() => probe.update(ctx.target, input.key, valuesOf(input.tag), expectVersion)),
					removeWithRead: ({ input, ctx }) => misuse(() => probe.remove(ctx.target, input.key)),
				},
			}),
		}),
		{ database: postgres.database },
	)
	const session = (worlds: IsolationWorlds) => createClient(probeContract, 'probe', { fetch: kit.browser(kit.testCaller(grantsIn(worlds))) })
	/** The parent and key a request names: a crossed row is the other key under the caller's own parent. */
	const address = (worlds: IsolationWorlds, row: ChildIsolationRow): { readonly parent: string; readonly key: string } => {
		const parentOf = worlds[row === 'other' ? 'other' : 'own'].parent
		if (parentOf === null) {
			throw new Error(`${table} is a child table, yet its seeded row has no parent`)
		}
		return { parent: parentOf, key: worlds[row === 'own' ? 'own' : 'other'].key }
	}
	const childKit: IsolationKit = {
		table,
		dimension: list,
		async get(row) {
			const worlds = await seed()
			const api = session(worlds)
			return attempt(async () => ({ status: 200, ...(await api.get(address(worlds, row))) }), (status) => ({ status, columns: [] }))
		},
		async list() {
			const worlds = await seed()
			const api = session(worlds)
			return attempt(async () => ({ status: 200, rows: reached(worlds, (await api.list()).keys) }), (status) => ({ status, rows: [] }))
		},
		async listByParent(row) {
			const worlds = await seed()
			const api = session(worlds)
			const { parent: parentKey } = address(worlds, row)
			return attempt(async () => ({ status: 200, rows: reached(worlds, (await api.listByParent({ parent: parentKey })).keys) }), (status) => ({
				status,
				rows: [],
			}))
		},
		async count() {
			const api = session(await seed())
			return attempt(async () => ({ status: 200, ...(await api.count()) }), (status) => ({ status, count: '' }))
		},
		async insert(into) {
			required('insert')
			const worlds = await seed()
			const api = session(worlds)
			const tag = tagged(await postgres.sampleInsert(tables, table))
			const { parent: parentKey } = address(worlds, into)
			return wrote(() => api.insert({ parent: parentKey, tag }))
		},
		async update(row) {
			required('update')
			const worlds = await seed()
			const api = session(worlds)
			const tag = tagged(worlds[row === 'own' ? 'own' : 'other'].updates)
			return wrote(() => api.update({ ...address(worlds, row), tag }))
		},
		async remove(row) {
			required('delete')
			const worlds = await seed()
			const api = session(worlds)
			return wrote(() => api.remove(address(worlds, row)))
		},
		async updateWithRead() {
			const worlds = await seed()
			const api = session(worlds)
			const tag = tagged(worlds.own.updates)
			return attempt(async () => ({ status: 200, ...(await api.updateWithRead({ ...address(worlds, 'own'), tag })) }), (status) => ({
				status,
				refused: false,
			}))
		},
		async removeWithRead() {
			const worlds = await seed()
			const api = session(worlds)
			return attempt(async () => ({ status: 200, ...(await api.removeWithRead(address(worlds, 'own'))) }), (status) => ({ status, refused: false }))
		},
	}
	return Object.freeze(childKit)
}

/** Which of the two seeded rows `keys` holds; a key of neither (a row another test seeded) is not one of them. */
function reached(worlds: IsolationWorlds, keys: readonly string[]): IsolationRow[] {
	const rows: IsolationRow[] = []
	if (keys.includes(worlds.own.key)) rows.push('own')
	if (keys.includes(worlds.other.key)) rows.push('other')
	return rows
}
