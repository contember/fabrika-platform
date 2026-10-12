// The endpoint access kit: the application's own `serve(…)`, booted by `testKit` on its own data layer, asked by
// callers of two scopes that share no value. A caller of one scope that names another scope's object or value must be
// refused by the access form; an answer to one scope must hold nothing of another, also right after that other scope
// was answered (a cache keyed by nothing); a caller that holds only the endpoint's action, or a link holder, reaches its
// own target. The author's seed sets the state a precondition needs. It cannot see a bug that needs other data or order.

import type { AccessForm, Caller, EndpointMethod, FileCollectionArtifact, SchemaShape } from '@fabrika/auth-core'
import type { Tables } from '@fabrika/db'
import { tablePolicies } from '@fabrika/db/tables'
import type { IsolationWorlds, SampleValue, TestDatabase } from '@fabrika/db/testing'
import { MemoryFileObjects } from '@fabrika/platform/testing'
import { z } from 'zod/v4'
import type { RpcFetch } from '../client/transport'
import type { AnyContract } from '../contract/define'
import type { ContractImplementation } from '../implement/implement'
import type { TestCaller, TestGrant } from './caller'
import { testKit } from './kit'

export interface DeniedOutcome {
	readonly status: number
}

/**
 * `answered` when every answer to the own scope is one the application gave: a 2xx, or a 4xx other than 401, 403 and
 * 404 (a precondition's 409 included). Otherwise `status` is the first other answer. `leaked` are the values of the
 * other scope's rows that the answers held: keys, parents, scope values and text markers.
 */
export type LeakOutcome =
	| { readonly answered: true; readonly leaked: readonly string[] }
	| { readonly answered: false; readonly status: number; readonly leaked: readonly string[] }

/** Column → value of the row of the table that owns the endpoint's dimension, in both scopes: the author's seed. */
export type Seed = Readonly<Record<string, SampleValue>>

export interface EndpointAccessKit {
	/**
	 * A caller holding the endpoint's action in one scope names an object (`on`) or a scope value (`in`) of another;
	 * `input` is the rest of a valid input, and its `from` field is replaced.
	 */
	denied(endpoint: string, input: Readonly<Record<string, unknown>>, seed?: Seed): Promise<DeniedOutcome>
	/**
	 * A caller of the other scope asks first, then a caller of one scope asks for its own object (`on`), its list
	 * (`over`) or, for every table that lies in the dimension, its scope value (`in`).
	 */
	leaked(endpoint: string, input: Readonly<Record<string, unknown>>, seed?: Seed): Promise<LeakOutcome>
	/**
	 * A caller that holds only the endpoint's action asks for its own object: a person or a script in its scope, or, on
	 * a link mount, the holder of a link bound to the object. A write action reads its own target.
	 */
	own(endpoint: string, input: Readonly<Record<string, unknown>>, seed?: Seed): Promise<DeniedOutcome>
	/**
	 * One file endpoint of `collection`, over a file seeded in each scope through the upload endpoint. `own` holds the
	 * operation's action in one scope and addresses its own owner row or file, `other` holds it there and addresses
	 * the other scope's, `reader` holds only the collection's read action and addresses its own.
	 */
	file(collection: string, operation: FileOperation, caller: 'own' | 'other' | 'reader'): Promise<DeniedOutcome>
}

export type FileOperation = 'upload' | 'download' | 'remove'

interface ActionEndpoint {
	readonly id: string
	/** The link mount of a link procedure; `null` for every other endpoint. */
	readonly link: string | null
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

const ascii = (text: string): number[] => [...text].map((char) => char.charCodeAt(0))
const ZIP_HEAD = [0x50, 0x4b, 0x03, 0x04]

/** The leading bytes `files/sniff.ts` accepts for each binary type it verifies; a text type needs none. */
const SAMPLE_HEADS: Readonly<Record<string, readonly number[]>> = {
	'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
	'image/jpeg': [0xff, 0xd8, 0xff, 0xe0],
	'image/gif': ascii('GIF89a'),
	'image/webp': [...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBP')],
	'application/pdf': ascii('%PDF-1.7\n'),
	'application/gzip': [0x1f, 0x8b, 0x08],
	'application/zip': ZIP_HEAD,
	'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ZIP_HEAD,
	'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ZIP_HEAD,
	'application/vnd.openxmlformats-officedocument.presentationml.presentation': ZIP_HEAD,
}
const TEXT_TYPES: ReadonlySet<string> = new Set(['text/plain', 'text/csv', 'text/markdown', 'application/json', 'image/svg+xml'])

/** A small file of the collection's first type the kit can write: the type's leading bytes, then a text marker. */
function sampleFile(name: string, types: readonly string[]): { readonly type: string; readonly bytes: Uint8Array<ArrayBuffer> } {
	for (const type of types) {
		const head = SAMPLE_HEADS[type] ?? (TEXT_TYPES.has(type) ? [] : undefined)
		if (head !== undefined) return { type, bytes: new Uint8Array([...head, ...ascii(`fabrika endpoint access file ${randomHex()}`)]) }
	}
	throw new Error(`files.${name}: none of its types is one the endpoint access kit can write a file of`)
}

const uploadedSchema = z.strictObject({ result: z.strictObject({ id: z.string() }) })

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
	// The objects of the files the cases seed live in memory; their rows are the application's own tables.
	const kit = testKit(app, { database: postgres.database, files: new MemoryFileObjects() })
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
			link: row.callers.some((caller) => caller === 'link') ? row.source.name : null,
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

	const ask = (row: ActionEndpoint, grants: readonly Grant[], body: unknown): Promise<{ readonly status: number; readonly text: string }> =>
		askAs(row, callerFor(row, grants).fetch, body)

	const askAs = async (row: ActionEndpoint, fetch: RpcFetch, body: unknown): Promise<{ readonly status: number; readonly text: string }> => {
		if (row.method !== 'POST') {
			throw new Error(`${row.id} is not a procedure`)
		}
		const response = await fetch(row.path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
		const text = await response.text()
		// Input is parsed before the access form runs: a refused input would hide what the case is about.
		if (response.status === 400) {
			throw new Error(`${row.id}: the case's input does not match the endpoint's input schema; correct its fixture (${text})`)
		}
		return { status: response.status, text }
	}

	const collectionOf = (name: string): FileCollectionArtifact => {
		const collection = kit.artifact.files[name]
		if (collection === undefined) throw new Error(`${name} is not a file collection of the contract`)
		return collection
	}

	const fileRow = (name: string, operation: FileOperation): { readonly method: EndpointMethod; readonly path: string } => {
		const row = kit.artifact.endpoints.find((candidate) => candidate.id === `files.${name}.${operation}`)
		if (row === undefined) throw new Error(`files.${name}.${operation} is not an endpoint of the contract`)
		return { method: row.method, path: row.path }
	}

	/** One owner row in each scope, and one file of each, written through the upload endpoint as a person of that scope. */
	const seedFiles = async (name: string) => {
		const collection = collectionOf(name)
		const worlds = await postgres.seedWorlds(tables, collection.owner)
		const upload = fileRow(name, 'upload')
		const put = async (world: 'own' | 'other'): Promise<string> => {
			const caller = kit.testCaller([{ action: collection.write, scope: { type: worlds.dimension, value: worlds[world].scope } }])
			const file = sampleFile(name, collection.types)
			const response = await kit.browser(caller)(upload.path.replace(':owner', encodeURIComponent(worlds[world].key)), {
				method: 'POST',
				headers: { 'Content-Type': file.type },
				body: file.bytes,
			})
			if (response.status !== 200) throw new Error(`files.${name}.upload: seeding a file of the ${world} scope answered ${response.status}`)
			return uploadedSchema.parse(await response.json()).result.id
		}
		return { collection, worlds, own: await put('own'), other: await put('other') }
	}

	/** Two scopes of `dimension`: rows of the table that owns it when one does, with `seed`, otherwise two fresh scope values. */
	const scopesOf = async (action: string, dimension: string, field: SchemaShape | undefined, seed: Seed): Promise<Scopes> => {
		const collection = Object.keys(kit.artifact.files).find((name) => dimension === `file:${name}`)
		if (collection !== undefined) {
			const seeded = await seedFiles(collection)
			const grant = (world: 'own' | 'other'): Grant[] => [{ action, scope: { type: seeded.worlds.dimension, value: seeded.worlds[world].scope } }]
			return {
				own: { target: seeded.own, grants: grant('own') },
				other: { target: seeded.other, grants: grant('other'), values: [...worldValues(seeded.worlds, 'other'), seeded.other] },
			}
		}
		const owner = ownerOf(dimension)
		if (owner === undefined) {
			const own = freshValue(dimension, 'own', field)
			const other = freshValue(dimension, 'other', field)
			return {
				own: { target: own, grants: [{ action, scope: { type: dimension, value: own } }] },
				other: { target: other, grants: [{ action, scope: { type: dimension, value: other } }], values: [other] },
			}
		}
		const worlds = await postgres.seedWorlds(tables, owner, seed)
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
			return scopesOf(action, dimension, undefined, {})
		}
		return { own: { target: '', grants: own }, other: { target: '', grants: other, values } }
	}

	/**
	 * For a report `in` `dimension`: one row in each scope of every table that lies in it, the table that owns it with
	 * `seed`. Each side's targets are its rows' values of `dimension`, and each caller holds all of them.
	 */
	const inScopesOf = async (action: string, dimension: string, field: SchemaShape | undefined, seed: Seed) => {
		const own: string[] = []
		const other: string[] = []
		const values: string[] = []
		for (const name of tableNames) {
			const mode = policies[name]?.scope.mode
			if (mode !== 'dimension' && mode !== 'child') continue
			const worlds = await postgres.seedWorlds(tables, name, name === ownerOf(dimension) ? seed : {})
			const ownValue = worlds.own.chain.find((link) => link.type === dimension)?.value
			const otherValue = worlds.other.chain.find((link) => link.type === dimension)?.value
			if (ownValue !== undefined && otherValue !== undefined) {
				own.push(ownValue)
				other.push(otherValue)
				values.push(...worldValues(worlds, 'other'))
			}
		}
		if (own.length === 0) {
			const scopes = await scopesOf(action, dimension, field, seed)
			return { own: [scopes.own.target], other: [scopes.other.target], values: scopes.other.values }
		}
		return { own, other, values }
	}

	const withTarget = (input: Readonly<Record<string, unknown>>, from: string | null, target: string): Readonly<Record<string, unknown>> =>
		from === null ? input : { ...input, [from]: target }

	/** The outcome of the own scope's answers: answered unless one is a failure or an authorization refusal. */
	const leakOutcome = (answers: readonly { readonly status: number; readonly text: string }[], values: readonly string[]): LeakOutcome => {
		const leaked = values.filter((value) => answers.some((answer) => answer.text.includes(value)))
		const refused = answers.find((answer) => answer.status >= 500 || answer.status === 401 || answer.status === 403 || answer.status === 404)
		return refused === undefined ? { answered: true, leaked } : { answered: false, status: refused.status, leaked }
	}

	/** A link holder of `row`'s mount, its key bound to the own world's object. */
	const linkHolder = async (row: ActionEndpoint, mount: string, seed: Seed): Promise<RpcFetch> => {
		const owner = ownerOf(row.access.dimension)
		if (owner === undefined) {
			throw new Error(`${row.id}: no table owns ${row.access.dimension}, so no link can be bound to one`)
		}
		const { own } = await postgres.seedWorlds(tables, owner, seed)
		const holder = kit.testCaller([{ action: row.action, scope: { type: row.access.dimension, value: own.key } }], {
			kind: 'link',
			link: { mount, chain: own.chain },
		})
		return (input, init) => {
			const headers = new Headers(init?.headers)
			headers.set('Authorization', `Bearer ${holder.key ?? ''}`)
			return kit.fetch(input, { ...init, headers })
		}
	}

	const accessKit: EndpointAccessKit = {
		async denied(endpoint, input, seed = {}) {
			const row = endpointOf(endpoint)
			const { action, access } = row
			if (access.form !== 'on' && access.form !== 'in') {
				throw new Error(`${endpoint} has the access form ${access.form}; only on and in name an object or a scope value`)
			}
			const scopes = await scopesOf(action, access.dimension, fieldOf(row.input, access.from), seed)
			const { status } = await ask(row, scopes.own.grants, withTarget(input, access.from, scopes.other.target))
			return { status }
		},
		async leaked(endpoint, input, seed = {}) {
			const row = endpointOf(endpoint)
			const { action, access } = row
			if (access.form === 'in') {
				const scopes = await inScopesOf(action, access.dimension, fieldOf(row.input, access.from), seed)
				const grants = (targets: readonly string[]): Grant[] => targets.map((value) => ({ action, scope: { type: access.dimension, value } }))
				for (const target of scopes.other) {
					await ask(row, grants(scopes.other), withTarget(input, access.from, target))
				}
				const answers = []
				for (const target of scopes.own) {
					answers.push(await ask(row, grants(scopes.own), withTarget(input, access.from, target)))
				}
				return leakOutcome(answers, scopes.values)
			}
			if (access.form !== 'on' && access.form !== 'over') {
				throw new Error(`${endpoint} has the access form ${access.form}; only on, in and over answer with rows of a scope`)
			}
			const scopes = access.form === 'on'
				? await scopesOf(action, access.dimension, fieldOf(row.input, access.from), seed)
				: await listScopesOf(action, access.dimension)
			const from = access.form === 'on' ? access.from : null
			await ask(row, scopes.other.grants, withTarget(input, from, scopes.other.target))
			const answer = await ask(row, scopes.own.grants, withTarget(input, from, scopes.own.target))
			return leakOutcome([answer], scopes.other.values)
		},
		async own(endpoint, input, seed = {}) {
			const row = endpointOf(endpoint)
			const { action, access } = row
			if (access.form !== 'on') {
				throw new Error(`${endpoint} has the access form ${access.form}; only on addresses an object of its own`)
			}
			if (row.link !== null) {
				const { status } = await askAs(row, await linkHolder(row, row.link, seed), input)
				return { status }
			}
			const scopes = await scopesOf(action, access.dimension, fieldOf(row.input, access.from), seed)
			const { status } = await ask(row, scopes.own.grants, withTarget(input, access.from, scopes.own.target))
			return { status }
		},
		async file(name, operation, caller) {
			const { collection, worlds, own, other } = await seedFiles(name)
			const operationAction = { upload: collection.write, download: collection.read, remove: collection.delete }[operation]
			const grants = [{ action: caller === 'reader' ? collection.read : operationAction, scope: { type: worlds.dimension, value: worlds.own.scope } }]
			const world = caller === 'other' ? 'other' : 'own'
			const fetch = kit.browser(kit.testCaller(grants))
			const row = fileRow(name, operation)
			if (operation === 'upload') {
				const file = sampleFile(name, collection.types)
				const path = row.path.replace(':owner', encodeURIComponent(worlds[world].key))
				return { status: (await fetch(path, { method: 'POST', headers: { 'Content-Type': file.type }, body: file.bytes })).status }
			}
			const fileId = world === 'own' ? own : other
			if (operation === 'download') {
				return { status: (await fetch(row.path.replace(':fileId', encodeURIComponent(fileId)))).status }
			}
			const body = JSON.stringify({ id: fileId })
			return { status: (await fetch(row.path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).status }
		},
	}
	return Object.freeze(accessKit)
}
