// The endpoint access kit: the application's own `serve(…)`, booted by `testKit` on its own data layer, asked by
// callers of two scopes that share no value. A caller of one scope that names another scope's object or value must be
// refused by the access form; an answer to one scope must hold nothing of another, also right after that other scope
// was answered (a cache keyed by nothing); a caller that holds only the endpoint's action, or a link holder, reaches its
// own target. The author's seed sets the state a precondition needs. It cannot see a bug that needs other data or order.

import {
	type AccessForm,
	type Caller,
	type EndpointDirectory,
	endpointDirectory,
	endpointMembers,
	type EndpointMethod,
	type FileCollectionArtifact,
	type SchemaShape,
} from '@fabrika/auth-core'
import type { Tables } from '@fabrika/db'
import { tablePolicies } from '@fabrika/db/tables'
import type { IsolationWorlds, SampleValue, TestDatabase } from '@fabrika/db/testing'
import { MemoryFileObjects } from '@fabrika/platform/testing'
import { z } from 'zod/v4'
import type { RpcFetch } from '../client/transport'
import { compileContract } from '../contract/compile'
import { GENERATED_MEMBER } from '../contract/defaults'
import type { AnyContract } from '../contract/define'
import { FILE_SCAN_JOB, type FileScanner, type ScanVerdict } from '../files/scan'
import type { ApplicationEnvironment, ContractImplementation } from '../implement/implement'
import type { TestCaller, TestGrant } from './caller'
import { standInIamKit } from './kit'
import { scopeTypeOf } from './policy-isolation'

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

/** `answered` unless the caller got a 401, a 403 or a 5xx; otherwise that status. */
export type ReachOutcome = { readonly answered: true } | { readonly answered: false; readonly status: number }

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
	/**
	 * An `app` or a `creates` endpoint asked by a caller who holds its action in one value of a dimension only, never
	 * globally: refused (403), by the proxy for `app` and by IAM for `creates`, since both need a global grant.
	 */
	scoped(endpoint: string, input: Readonly<Record<string, unknown>>): Promise<DeniedOutcome>
	/**
	 * An `app` or a `creates` endpoint asked by a caller who holds its action as a global grant, and nothing else:
	 * `answered` unless the answer is a 401, a 403 or a 5xx.
	 */
	global(endpoint: string, input: Readonly<Record<string, unknown>>): Promise<ReachOutcome>
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
	/** The member directory the endpoint reads, or `null`. */
	readonly directory: EndpointDirectory | null
	/** Its dimension when its action is the dimension's `members.manage`, which IAM checks on the value itself; else `null`. */
	readonly manages: string | null
	/** The actions of the link mounts it issues, which IAM requires of the issuer beside `issuedBy`. */
	readonly linkGrants: readonly string[]
}

/** Every dimension value a target lies in, its own first: where a member directory of its scope is found. */
type Chain = readonly { readonly type: string; readonly value: string }[]

/** The two scopes a case asks from: a target of each, the values the other's rows hold, and the grants of each. */
interface Scopes {
	readonly own: { readonly target: string; readonly grants: readonly Grant[]; readonly chain: Chain }
	readonly other: { readonly target: string; readonly grants: readonly Grant[]; readonly values: readonly string[]; readonly chain: Chain }
}

/** A case's input, and the values it named that only its own scope may see in an answer: a generated member's id and label. */
interface Addressed {
	readonly input: Readonly<Record<string, unknown>>
	readonly marks: readonly string[]
}

/** One target of an `in` report, with its chain from the target outward. */
interface InTarget {
	readonly target: string
	readonly chain: Chain
}

type Grant =
	| { readonly action: string; readonly scope: { readonly type: string; readonly value: string } }
	| { readonly role: string; readonly scope: { readonly type: string; readonly value: string } }

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

/** Every value of the other world a leak shows: its key, parent, every dimension value it lies in, and its markers. */
function worldValues(worlds: IsolationWorlds, world: 'own' | 'other'): string[] {
	const row = worlds[world]
	return [...new Set([row.key, row.scope, ...(row.parent === null ? [] : [row.parent]), ...row.chain.map((link) => link.value), ...row.markers])]
}

/** The cases' scanner: a file it reads in full is clean, so a seeded upload of a `scan: true` collection is served. */
const cleanScanner: FileScanner = {
	async scan(objects, signal) {
		const verdicts = new Map<string, ScanVerdict>()
		for (const object of objects) {
			try {
				await new Response(await object.open(signal)).arrayBuffer()
				verdicts.set(object.id, { kind: 'clean' })
			} catch {
				// No verdict: the file stays quarantined, and its case answers the 409 that shows it.
			}
		}
		return { ok: true, verdicts }
	},
}

/**
 * The variables `boot` requires of `app` that a generated case never uses: each form challenge's secret, since no case
 * submits a form. The kit's challenge stand-in refuses every token, so no verification leaves the process.
 */
function unusedVariables(app: ContractImplementation<AnyContract>): ApplicationEnvironment {
	const artifact = compileContract(app.contract, app.database?.tables ?? {})
	return Object.fromEntries(
		Object.values(artifact.mounts).flatMap((
			mount,
		) => (mount.kind === 'form' && mount.challenge !== undefined ? [[mount.challenge.secret, 'unused']] : [])),
	)
}

/**
 * The endpoint access kit of `app`, whose data layer is `scoped(tables)`, over `postgres`. It boots `app` once, so the
 * application's layer is bound here and nowhere else in the process.
 */
export function endpointAccessKit<DB, P>(app: ContractImplementation<AnyContract>, tables: Tables<DB, P>, postgres: TestDatabase): EndpointAccessKit {
	// The objects of the files the cases seed live in memory; their rows are the application's own tables.
	const kit = standInIamKit(app, {
		database: postgres.database,
		files: new MemoryFileObjects(),
		scanner: cleanScanner,
		env: unusedVariables(app),
		challengeFetch: () => Promise.resolve(Response.json({ success: false, 'error-codes': ['invalid-input-response'] })),
	})
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
			directory: endpointDirectory(kit.artifact, row),
			manages: endpointMembers(kit.artifact, row) === 'manage' && 'dimension' in requirement.access ? requirement.access.dimension : null,
			linkGrants: linkGrantsOf(row.id, requirement.action, requirement.access),
		}
	}

	/** The grants of the link mounts an endpoint's `Ref` issues for: its dimension's whose `issuedBy` is its action. */
	const linkGrantsOf = (id: string, action: string, access: AccessForm): string[] => {
		if (access.form !== 'on' && access.form !== 'in') return []
		const issues = kit.artifact.declared?.[id]?.issues
		return Object.entries(kit.artifact.mounts).flatMap(([name, mount]) =>
			mount.kind === 'link' && mount.dimension === access.dimension && mount.issuedBy === action && (issues === undefined || issues === name)
				? mount.grants
				: []
		)
	}

	const globalEndpointOf = (id: string): ActionEndpoint => {
		const row = endpointOf(id)
		if (row.access.form !== 'app' && row.access.form !== 'creates') {
			throw new Error(`${id} has the access form ${row.access.form}; only app and creates need the action held globally`)
		}
		return row
	}

	/** The dimension a table's rows are listed by: a dimension table's container or its own; a child's parent's. */
	const listDimensionOf = (name: string): string | undefined => {
		const scope = policies[name]?.scope
		if (scope?.mode === 'dimension') return scope.container?.dimension ?? scope.dimension
		if (scope?.mode !== 'child') return undefined
		const parent = policies[scope.parent]?.scope
		return parent?.mode === 'dimension' ? (parent.container?.dimension ?? parent.dimension) : undefined
	}

	const callerFor = (
		row: ActionEndpoint,
		grants: readonly Grant[],
		global: readonly { readonly action: string }[] = [],
	): { readonly caller: TestCaller; readonly fetch: RpcFetch } => {
		const asGrants: TestGrant<AnyContract>[] = [
			...grants.map((grant) => ('role' in grant ? { role: grant.role, scope: grant.scope } : { action: grant.action, scope: grant.scope })),
			...global,
		]
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
			throw new Error(
				`${row.id}: the case's input does not match the endpoint's input schema, or names no member its handler accepts; correct its fixture, or name the member field in members (${text})`,
			)
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
		const seeded = { collection, worlds, own: await put('own'), other: await put('other') }
		if (collection.scan === true) await kit.runJob(FILE_SCAN_JOB)
		return seeded
	}

	/** Two scopes of `dimension`: rows of the table that owns it when one does, with `seed`, otherwise two fresh scope values. */
	const scopesOf = async (action: string, dimension: string, field: SchemaShape | undefined, seed: Seed): Promise<Scopes> => {
		const collection = Object.keys(kit.artifact.files).find((name) => dimension === `file:${name}`)
		if (collection !== undefined) {
			const seeded = await seedFiles(collection)
			const grant = (world: 'own' | 'other'): Grant[] => [{ action, scope: { type: seeded.worlds.dimension, value: seeded.worlds[world].scope } }]
			return {
				own: { target: seeded.own, grants: grant('own'), chain: seeded.worlds.own.chain },
				other: {
					target: seeded.other,
					grants: grant('other'),
					values: [...worldValues(seeded.worlds, 'other'), seeded.other],
					chain: seeded.worlds.other.chain,
				},
			}
		}
		const owner = ownerOf(dimension)
		if (owner === undefined) {
			const own = freshValue(dimension, 'own', field)
			const other = freshValue(dimension, 'other', field)
			return {
				own: { target: own, grants: [{ action, scope: { type: dimension, value: own } }], chain: [{ type: dimension, value: own }] },
				other: {
					target: other,
					grants: [{ action, scope: { type: dimension, value: other } }],
					values: [other],
					chain: [{ type: dimension, value: other }],
				},
			}
		}
		const worlds = await postgres.seedWorlds(tables, owner, seed)
		return {
			own: { target: worlds.own.key, grants: [{ action, scope: { type: worlds.dimension, value: worlds.own.scope } }], chain: worlds.own.chain },
			other: {
				target: worlds.other.key,
				grants: [{ action, scope: { type: worlds.dimension, value: worlds.other.scope } }],
				values: worldValues(worlds, 'other'),
				chain: worlds.other.chain,
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
		return { own: { target: '', grants: own, chain: [] }, other: { target: '', grants: other, values, chain: [] } }
	}

	/**
	 * For a report `in` `dimension`: one row in each scope of every table that lies in it, the table that owns it with
	 * `seed`. Each side's targets are its rows' values of `dimension`, and each caller holds all of them.
	 */
	const inScopesOf = async (action: string, dimension: string, field: SchemaShape | undefined, seed: Seed) => {
		const own: InTarget[] = []
		const other: InTarget[] = []
		const values: string[] = []
		for (const name of tableNames) {
			const mode = policies[name]?.scope.mode
			if (mode !== 'dimension' && mode !== 'child') continue
			const worlds = await postgres.seedWorlds(tables, name, name === ownerOf(dimension) ? seed : {})
			const ownAt = worlds.own.chain.findIndex((link) => link.type === dimension)
			const otherAt = worlds.other.chain.findIndex((link) => link.type === dimension)
			const ownValue = worlds.own.chain[ownAt]?.value
			const otherValue = worlds.other.chain[otherAt]?.value
			if (ownValue !== undefined && otherValue !== undefined) {
				own.push({ target: ownValue, chain: worlds.own.chain.slice(ownAt) })
				other.push({ target: otherValue, chain: worlds.other.chain.slice(otherAt) })
				values.push(...worldValues(worlds, 'other'))
			}
		}
		if (own.length === 0) {
			const scopes = await scopesOf(action, dimension, field, seed)
			return { own: [scopes.own], other: [scopes.other], values: scopes.other.values }
		}
		return { own, other, values }
	}

	const withTarget = (input: Readonly<Record<string, unknown>>, from: string | null, target: string): Readonly<Record<string, unknown>> =>
		from === null ? input : { ...input, [from]: target }

	/**
	 * `input` with every field that holds `GENERATED_MEMBER` set to a new member of the directory's value in `chain`: a
	 * principal holding a membership role of the directory's dimension there, which the kit's directory answers. `marks`
	 * are the member's id and label, which an answer to the other scope must not hold.
	 */
	const withMember = (row: ActionEndpoint, input: Readonly<Record<string, unknown>>, chain: Chain): Addressed => {
		const fields = Object.keys(input).filter((field) => input[field] === GENERATED_MEMBER)
		if (fields.length === 0) return { input, marks: [] }
		const directory = row.directory
		if (directory === null) {
			throw new Error(`${row.id} reads no member directory, so no input field of it names a member (${fields.join(', ')})`)
		}
		const value = chain.find((link) => link.type === directory.dimension)?.value
		if (value === undefined) {
			throw new Error(`${row.id}: no table locates the ${directory.dimension} of its target, so the kit cannot make a member there`)
		}
		const role = Object.keys(kit.artifact.roles).sort().find((name) => kit.artifact.roles[name]?.member?.scope === directory.dimension)
		if (role === undefined) {
			throw new Error(`${row.id}: ${directory.dimension} has no membership role, so the kit cannot make a member there`)
		}
		const marker = randomHex() + randomHex()
		const member = kit.testCaller([{ role, scope: { type: directory.dimension, value } }], {
			id: `member-${marker}`,
			label: `member-${marker}@example.test`,
		})
		return {
			input: { ...input, ...Object.fromEntries(fields.map((field) => [field, member.id])) },
			marks: [member.id, ...(member.label === null ? [] : [member.label])],
		}
	}

	/**
	 * The grants a case's caller holds: its side's, or, on an endpoint that reads a member directory, the action on the
	 * directory's value, where IAM checks a lookup and a list: a caller who may read it, still only in its own scope. On
	 * an endpoint that manages members it is the action on the target's own value, with every membership role there, so
	 * IAM finds an assigning role and the actions of the role assigned. An endpoint that issues links adds the actions
	 * its mounts grant, which IAM requires of the issuer.
	 */
	const holding = (row: ActionEndpoint, grants: readonly Grant[], chain: Chain): readonly Grant[] => {
		const { directory, manages } = row
		const at = (dimension: string) => chain.find((link) => link.type === dimension)?.value
		const managed = manages === null ? undefined : at(manages)
		const listed = directory === null ? undefined : at(directory.dimension)
		let held = grants
		if (manages !== null && managed !== undefined) {
			const scope = { type: manages, value: managed }
			const roles = Object.keys(kit.artifact.roles).sort().filter((role) => kit.artifact.roles[role]?.member?.scope === manages)
			held = [{ action: row.action, scope }, ...roles.map((role) => ({ role, scope }))]
		} else if (directory !== null && listed !== undefined) {
			held = [{ action: row.action, scope: { type: directory.dimension, value: listed } }]
		}
		const scopes = held.flatMap((grant) => ('action' in grant ? [grant.scope] : []))
		return [...held, ...row.linkGrants.flatMap((action) => scopes.map((scope) => ({ action, scope })))]
	}

	const addressed = (
		row: ActionEndpoint,
		input: Readonly<Record<string, unknown>>,
		from: string | null,
		side: { readonly target: string; readonly chain: Chain },
	): Addressed => withMember(row, withTarget(input, from, side.target), side.chain)

	/** The outcome of the own scope's answers: answered unless one is a failure or an authorization refusal. */
	const leakOutcome = (answers: readonly { readonly status: number; readonly text: string }[], values: readonly string[]): LeakOutcome => {
		const leaked = values.filter((value) => answers.some((answer) => answer.text.includes(value)))
		const refused = answers.find((answer) => answer.status >= 500 || answer.status === 401 || answer.status === 403 || answer.status === 404)
		return refused === undefined ? { answered: true, leaked } : { answered: false, status: refused.status, leaked }
	}

	/** A link holder of `row`'s mount, its key bound to the own world's object. */
	const linkHolder = async (row: ActionEndpoint, mount: string, seed: Seed): Promise<RpcFetch> => {
		const access = row.access
		if (access.form !== 'on') {
			throw new Error(`${row.id} is a link procedure, so its access form is on the link's object, not ${access.form}`)
		}
		const owner = ownerOf(access.dimension)
		if (owner === undefined) {
			throw new Error(`${row.id}: no table owns ${access.dimension}, so no link can be bound to one`)
		}
		const { own } = await postgres.seedWorlds(tables, owner, seed)
		const holder = kit.testCaller([{ action: row.action, scope: { type: access.dimension, value: own.key } }], {
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
			const asked = withMember(row, withTarget(input, access.from, scopes.other.target), scopes.own.chain)
			const { status } = await ask(row, holding(row, scopes.own.grants, scopes.own.chain), asked.input)
			return { status }
		},
		async leaked(endpoint, input, seed = {}) {
			const row = endpointOf(endpoint)
			const { action, access } = row
			if (access.form === 'in') {
				const scopes = await inScopesOf(action, access.dimension, fieldOf(row.input, access.from), seed)
				const grants = (targets: readonly InTarget[]): Grant[] =>
					targets.flatMap(({ target, chain }) => holding(row, [{ action, scope: { type: access.dimension, value: target } }], chain))
				const marks: string[] = []
				for (const side of scopes.other) {
					const asked = addressed(row, input, access.from, side)
					marks.push(...asked.marks)
					await ask(row, grants(scopes.other), asked.input)
				}
				const answers = []
				for (const side of scopes.own) {
					answers.push(await ask(row, grants(scopes.own), addressed(row, input, access.from, side).input))
				}
				return leakOutcome(answers, [...scopes.values, ...marks])
			}
			if (access.form !== 'on' && access.form !== 'over') {
				throw new Error(`${endpoint} has the access form ${access.form}; only on, in and over answer with rows of a scope`)
			}
			const scopes = access.form === 'on'
				? await scopesOf(action, access.dimension, fieldOf(row.input, access.from), seed)
				: await listScopesOf(action, access.dimension)
			const from = access.form === 'on' ? access.from : null
			const other = addressed(row, input, from, scopes.other)
			await ask(row, holding(row, scopes.other.grants, scopes.other.chain), other.input)
			const answer = await ask(row, holding(row, scopes.own.grants, scopes.own.chain), addressed(row, input, from, scopes.own).input)
			return leakOutcome([answer], [...scopes.other.values, ...other.marks])
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
			const { status } = await ask(row, holding(row, scopes.own.grants, scopes.own.chain), addressed(row, input, access.from, scopes.own).input)
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
		async scoped(endpoint, input) {
			const row = globalEndpointOf(endpoint)
			const dimension = row.access.form === 'creates' ? row.access.dimension : scopeTypeOf(kit.artifact.dimensions)
			const { status } = await ask(row, [{ action: row.action, scope: { type: dimension, value: freshValue(dimension, 'own', undefined) } }], input)
			return { status }
		},
		async global(endpoint, input) {
			const row = globalEndpointOf(endpoint)
			const { status } = await askAs(row, callerFor(row, [], [{ action: row.action }]).fetch, input)
			// Neither form refuses with 404, so a 404 is the handler's own answer (a row the sampled input names is missing).
			return status >= 500 || status === 401 || status === 403 ? { answered: false, status } : { answered: true }
		},
	}
	return Object.freeze(accessKit)
}
