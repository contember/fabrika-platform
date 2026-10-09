// The endpoint access kit: the application's own `implement`, booted by `testKit` on its own data layer, asked by
// callers of two scopes that share no value. A caller of one scope that names another scope's object or value must be
// refused by the access form; an answer to one scope must hold nothing of another, also right after that other scope
// was answered (a cache keyed by nothing). It cannot see an application bug that needs other data or another order.

import type { AccessForm, Caller, EndpointMethod, SchemaShape } from '@fabrika/auth-core'
import type { Tables } from '@fabrika/db'
import { tablePolicies } from '@fabrika/db/tables'
import type { IsolationWorlds, TestDatabase } from '@fabrika/db/testing'
import type { RpcFetch } from '../client/transport'
import type { AnyContract } from '../contract/define'
import type { ContractImplementation } from '../implement/implement'
import type { TestCaller, TestGrant } from './caller'
import { testKit } from './kit'

export interface DeniedOutcome {
	readonly status: number
}

export interface LeakOutcome {
	/** The status of the answer to one scope. */
	readonly status: number
	/** The values of the other scope's rows that the answer held: keys, parents, scope values and text markers. */
	readonly leaked: readonly string[]
}

export interface EndpointAccessKit {
	/**
	 * A caller holding the endpoint's action in one scope names an object (`on`) or a scope value (`in`) of another;
	 * `input` is the rest of a valid input, and its `from` field is replaced.
	 */
	denied(endpoint: string, input: Readonly<Record<string, unknown>>): Promise<DeniedOutcome>
	/** A caller of the other scope asks first, then a caller of one scope asks for its own (`on`) or its list (`over`). */
	leaked(endpoint: string, input: Readonly<Record<string, unknown>>): Promise<LeakOutcome>
}

interface ActionEndpoint {
	readonly id: string
	readonly method: EndpointMethod
	readonly path: string
	readonly callers: readonly Caller[]
	readonly action: string
	readonly access: AccessForm
	readonly input: SchemaShape | null
}

/** The two scopes a case asks from: a target of each, the values the other's rows hold, and the grants of each. */
interface Scopes {
	readonly own: { readonly target: string; readonly grants: readonly Grant[] }
	readonly other: { readonly target: string; readonly grants: readonly Grant[]; readonly values: readonly string[] }
}

interface Grant {
	readonly action: string
	readonly scope: { readonly type: string; readonly value: string }
}

const randomHex = (): string => crypto.randomUUID().replaceAll('-', '').slice(0, 8)

/** A scope value no table holds, in the format of the input field it is sent in. */
function freshValue(dimension: string, world: 'own' | 'other', field: SchemaShape | undefined): string {
	const format = field?.type === 'string' ? field.format : null
	if (format === 'uuid') return crypto.randomUUID()
	if (format === 'email') return `${dimension}-${world}-${randomHex()}@example.test`
	return `${dimension}-${world}-${randomHex()}`
}

/** The shape of the input field a scope value is read from. */
function fieldOf(input: SchemaShape | null, from: string | null): SchemaShape | undefined {
	return input?.type === 'object' && from !== null ? input.fields[from] : undefined
}

function worldValues(worlds: IsolationWorlds, world: 'own' | 'other'): string[] {
	const row = worlds[world]
	return [row.key, row.scope, ...(row.parent === null ? [] : [row.parent]), ...row.markers]
}

/**
 * The endpoint access kit of `app`, whose data layer is `scoped(tables)`, over `postgres`. It boots `app` once, so the
 * application's layer is bound here and nowhere else in the process.
 */
export function endpointAccessKit<DB, P>(app: ContractImplementation<AnyContract>, tables: Tables<DB, P>, postgres: TestDatabase): EndpointAccessKit {
	const kit = testKit(app, { database: postgres.database })
	const policies = tablePolicies(tables)
	const tableNames = Object.keys(policies).sort()

	const ownerOf = (dimension: string): string | undefined =>
		tableNames.find((name) => {
			const scope = policies[name]?.scope
			return scope?.mode === 'dimension' && scope.dimension === dimension
		})

	const endpointOf = (id: string): ActionEndpoint => {
		const row = kit.artifact.endpoints.find((candidate) => candidate.id === id)
		const requirement = row?.requirement
		if (row === undefined || requirement === null || requirement === undefined || requirement.kind !== 'action' || row.callers.length === 0) {
			throw new Error(`${id} is not an endpoint of the contract with an action requirement`)
		}
		return {
			id: row.id,
			method: row.method,
			path: row.path,
			callers: row.callers,
			action: requirement.action,
			access: requirement.access,
			input: row.input,
		}
	}

	/** The dimension a table's rows are listed by: a dimension table's container or its own; a child's parent's. */
	const listDimensionOf = (name: string): string | undefined => {
		const scope = policies[name]?.scope
		if (scope?.mode === 'dimension') return scope.container?.dimension ?? scope.dimension
		if (scope?.mode !== 'child') return undefined
		const parent = policies[scope.parent]?.scope
		return parent?.mode === 'dimension' ? (parent.container?.dimension ?? parent.dimension) : undefined
	}

	const callerFor = (row: ActionEndpoint, grants: readonly Grant[]): { readonly caller: TestCaller; readonly fetch: RpcFetch } => {
		const asGrants: TestGrant<AnyContract>[] = grants.map((grant) => ({ action: grant.action, scope: grant.scope }))
		if (row.callers.some((caller) => caller === 'human')) {
			const caller = kit.testCaller(asGrants)
			return { caller, fetch: kit.browser(caller) }
		}
		if (row.callers.some((caller) => caller === 'machine')) {
			const caller = kit.testCaller(asGrants, { kind: 'machine' })
			return {
				caller,
				fetch: (input, init) => {
					const headers = new Headers(init?.headers)
					headers.set('Authorization', `Bearer ${caller.key ?? ''}`)
					return kit.fetch(input, { ...init, headers })
				},
			}
		}
		throw new Error(`${row.id} admits neither a human nor a machine caller`)
	}

	const ask = async (row: ActionEndpoint, grants: readonly Grant[], body: unknown): Promise<{ readonly status: number; readonly text: string }> => {
		if (row.method !== 'POST') {
			throw new Error(`${row.id} is not a procedure`)
		}
		const { fetch } = callerFor(row, grants)
		const response = await fetch(row.path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
		const text = await response.text()
		// Input is parsed before the access form runs: a refused input would hide what the case is about.
		if (response.status === 400) {
			throw new Error(`${row.id}: the case's input does not match the endpoint's input schema; correct its fixture (${text})`)
		}
		return { status: response.status, text }
	}

	/** Two scopes of `dimension`: rows of the table that owns it when one does, otherwise two fresh scope values. */
	const scopesOf = async (action: string, dimension: string, field: SchemaShape | undefined): Promise<Scopes> => {
		const owner = ownerOf(dimension)
		if (owner === undefined) {
			const own = freshValue(dimension, 'own', field)
			const other = freshValue(dimension, 'other', field)
			return {
				own: { target: own, grants: [{ action, scope: { type: dimension, value: own } }] },
				other: { target: other, grants: [{ action, scope: { type: dimension, value: other } }], values: [other] },
			}
		}
		const worlds = await postgres.seedWorlds(tables, owner)
		return {
			own: { target: worlds.own.key, grants: [{ action, scope: { type: worlds.dimension, value: worlds.own.scope } }] },
			other: {
				target: worlds.other.key,
				grants: [{ action, scope: { type: worlds.dimension, value: worlds.other.scope } }],
				values: worldValues(worlds, 'other'),
			},
		}
	}

	/** For a list of `dimension`: one row in each scope of every table listed by it; each caller holds every scope of its side. */
	const listScopesOf = async (action: string, dimension: string): Promise<Scopes> => {
		const own: Grant[] = []
		const other: Grant[] = []
		const values: string[] = []
		for (const name of tableNames) {
			if (listDimensionOf(name) === dimension) {
				const worlds = await postgres.seedWorlds(tables, name)
				own.push({ action, scope: { type: dimension, value: worlds.own.scope } })
				other.push({ action, scope: { type: dimension, value: worlds.other.scope } })
				values.push(...worldValues(worlds, 'other'))
			}
		}
		if (own.length === 0) {
			return scopesOf(action, dimension, undefined)
		}
		return { own: { target: '', grants: own }, other: { target: '', grants: other, values } }
	}

	const withTarget = (input: Readonly<Record<string, unknown>>, from: string | null, target: string): Readonly<Record<string, unknown>> =>
		from === null ? input : { ...input, [from]: target }

	const accessKit: EndpointAccessKit = {
		async denied(endpoint, input) {
			const row = endpointOf(endpoint)
			const { action, access } = row
			if (access.form !== 'on' && access.form !== 'in') {
				throw new Error(`${endpoint} has the access form ${access.form}; only on and in name an object or a scope value`)
			}
			const scopes = await scopesOf(action, access.dimension, fieldOf(row.input, access.from))
			const { status } = await ask(row, scopes.own.grants, withTarget(input, access.from, scopes.other.target))
			return { status }
		},
		async leaked(endpoint, input) {
			const row = endpointOf(endpoint)
			const { action, access } = row
			if (access.form !== 'on' && access.form !== 'over') {
				throw new Error(`${endpoint} has the access form ${access.form}; only on and over answer with rows of a scope`)
			}
			const scopes = access.form === 'on'
				? await scopesOf(action, access.dimension, fieldOf(row.input, access.from))
				: await listScopesOf(action, access.dimension)
			const from = access.form === 'on' ? access.from : null
			await ask(row, scopes.other.grants, withTarget(input, from, scopes.other.target))
			const { status, text } = await ask(row, scopes.own.grants, withTarget(input, from, scopes.own.target))
			return { status, leaked: scopes.other.values.filter((value) => text.includes(value)) }
		},
	}
	return Object.freeze(accessKit)
}
