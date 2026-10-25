// The endpoint access kit: the application's own `serve(…)`, booted by `testKit` on its own data layer, asked by
// callers of two scopes that share no value. A caller of one scope that names another scope's object or value must be
// refused by the access form; an answer to one scope must hold nothing of another, also right after that other scope
// was answered (a cache keyed by nothing); a caller that holds only the endpoint's action, or a link holder, reaches its
// own target. The author's seed sets the state a precondition needs. It cannot see a bug that needs other data or order.

import {
	type AccessForm,
	type Caller,
	type ContractArtifact,
	type EndpointDirectory,
	endpointDirectory,
	endpointMembers,
	type EndpointMethod,
	type ProcedureChallenge,
	type SchemaShape,
	type Scope,
} from '@fabrika/auth-core'
import type { Tables } from '@fabrika/db'
import { tablePolicies } from '@fabrika/db/tables'
import { type IsolationWorlds, type SampleValue, SEEDED_OBJECT_VERSION, type TestDatabase, type WorldRow } from '@fabrika/db/testing'
import { MemoryFileObjects } from '@fabrika/platform/testing'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod/v4'
import type { RpcFetch } from '../client/transport'
import { compileContract } from '../contract/compile'
import {
	FILE_INPUT_PART,
	GENERATED_FILE_PREFIX,
	GENERATED_INVITATION,
	GENERATED_LINK,
	GENERATED_MEMBER,
	GENERATED_ROW_PREFIX,
} from '../contract/defaults'
import type { AnyContract } from '../contract/define'
import type { FileScanner, ScanVerdict } from '../files/scan'
import { bytesAreOfType, SNIFF_BYTES } from '../files/sniff'
import type { ApplicationEnvironment, ContractImplementation } from '../implement/implement'
import type { TestCaller, TestGrant } from './caller'
import { standInIamKit } from './kit'
import { scopeTypeOf } from './policy-isolation'
import { sampleFile } from './sample-file'

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

/**
 * Table → column → value: one row of each application table the handler reads for the caller's own scope, seeded
 * before a leak or an own case asks and removed once it is over, with every row that refers to it, so no other case
 * finds it. Both scopes may see it, so its values are never counted as the other scope's.
 */
export type AppRows = Readonly<Record<string, Seed>>

export interface EndpointAccessKit {
	/**
	 * A caller holding the endpoint's action in one scope names an object (`on`) or a scope value (`in`) of another;
	 * `input` is the rest of a valid input, and its `from` field is replaced.
	 */
	denied(endpoint: string, input: Readonly<Record<string, unknown>>, seed?: Seed): Promise<DeniedOutcome>
	/**
	 * A caller of the other scope asks first, then a caller of one scope asks for its own object (`on`), its list
	 * (`over`) or, for every table that lies in the dimension, its scope value (`in`). `appRows` are seeded first, as
	 * for `own`.
	 */
	leaked(endpoint: string, input: Readonly<Record<string, unknown>>, seed?: Seed, appRows?: AppRows): Promise<LeakOutcome>
	/**
	 * A caller that holds only the endpoint's action asks for its own object: a person or a script in its scope, or, on
	 * a link mount, the holder of a link bound to the object. A write action reads its own target. Where IAM requires more
	 * of the caller, it holds that too: a member manager an assigning role and the assigned role's actions, a link's
	 * issuer the actions the link grants. `appRows` are the rows of application tables its handler reads (the guide a link
	 * holder downloads), each seeded first.
	 */
	own(endpoint: string, input: Readonly<Record<string, unknown>>, seed?: Seed, appRows?: AppRows): Promise<DeniedOutcome>
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
	/**
	 * One capability of an endpoint of several, refused while every other one passes: the caller holds each other one's
	 * action in a scope of its own and addresses its object or value there (or, for `over`, holds the action globally).
	 * For an `on` or `in` capability it also holds the named one's action in its own scope and addresses the other's
	 * object (404) or value (403); for `over` it holds the named action nowhere (403). `seed` is the named one's.
	 */
	capability(endpoint: string, capability: string, input: Readonly<Record<string, unknown>>, seed?: Seed): Promise<DeniedOutcome>
	/**
	 * A public procedure asked by anyone, with no credential, from a page of its own origin: `answered` unless the answer
	 * is a 401, a 403, a 5xx or a failed challenge. A procedure with a challenge is a 400 `challenge_failed`: the kit's
	 * challenge never passes.
	 */
	anyone(endpoint: string, input: Readonly<Record<string, unknown>>): Promise<ReachOutcome>
}

export interface EndpointAccessOptions {
	/**
	 * The file every case of an endpoint sends in a file field instead of the kit's sample, by endpoint id and input
	 * field: a file of the application's repository that a handler inspecting the content accepts (a valid package). Its
	 * type is the first of the field's kind that its bytes are; a file of none of them throws. `files` of the fixtures.
	 */
	readonly files?: Readonly<Record<string, Readonly<Record<string, URL>>>>
	/**
	 * The error types of the refusals (400) an endpoint's handler answers its own object with when the case's input meets
	 * no domain rule the kit can satisfy, by endpoint id: such a 400 is the handler's own answer, so the request passed
	 * the access form, and the endpoint's own case gets it as `{ status: 400 }` instead of failing. A leak, global or
	 * capability case still throws on it (an answer that holds nothing proves no isolation), so does any other 400, and an
	 * input the schema refuses (`validation`) always does. `refusals` of the fixtures.
	 */
	readonly refusals?: Readonly<Record<string, readonly string[]>>
}

/** Whether a case takes a refusal the fixtures declare for its endpoint as the handler's answer: only an own case does. */
type Refusals = 'declared' | 'none'

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
	/** The link mounts it issues for its `Ref`: their names, and the actions they grant, which IAM requires of the issuer. */
	readonly links: readonly { readonly mount: string; readonly grants: readonly string[] }[]
}

/** Every dimension value a target lies in, its own first: where a member directory of its scope is found. */
type Chain = readonly { readonly type: string; readonly value: string }[]

/**
 * One scope a case asks from: its target, the grants a caller of it holds, the target's chain, and the key of each row
 * the case names in its target (`rows`), by input field.
 */
interface Side {
	readonly target: string
	readonly grants: readonly Grant[]
	readonly chain: Chain
	readonly rows: Readonly<Record<string, string>>
}

/** The two scopes a case asks from, and the values the other's rows hold. */
interface Scopes {
	readonly own: Side
	readonly other: Side & { readonly values: readonly string[] }
}

/** The input fields that name a row the kit seeds in the case's object (`rows`), with the row's table. */
function rowFields(input: Readonly<Record<string, unknown>>): readonly { readonly field: string; readonly table: string }[] {
	return Object.entries(input).flatMap(([field, value]) =>
		typeof value === 'string' && value.startsWith(GENERATED_ROW_PREFIX) ? [{ field, table: value.slice(GENERATED_ROW_PREFIX.length) }] : []
	)
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

export type Grant =
	| { readonly action: string; readonly scope: { readonly type: string; readonly value: string } }
	| { readonly role: string; readonly scope: { readonly type: string; readonly value: string } }

const randomHex = (): string => crypto.randomUUID().replaceAll('-', '').slice(0, 8)

const errorSchema = z.object({ error: z.object({ type: z.string() }) })

/** The file fields of a procedure's input: a file, an optional one, or an array of them, each sent as a part of its own. */
function fileFields(input: SchemaShape | null): ReadonlySet<string> {
	const isFile = (shape: SchemaShape): boolean =>
		shape.type === 'file' || ((shape.type === 'optional' || shape.type === 'array') && isFile(shape.type === 'array' ? shape.items : shape.inner))
	return new Set(input?.type === 'object' ? Object.entries(input.fields).filter(([, shape]) => isFile(shape)).map(([name]) => name) : [])
}

/** The file kind a generated file field's marker names, or `undefined` for any other value. */
function fileKindOf(value: unknown): string | undefined {
	return typeof value === 'string' && value.startsWith(GENERATED_FILE_PREFIX) ? value.slice(GENERATED_FILE_PREFIX.length) : undefined
}

/** The `type` of an error envelope, or `undefined` for any other body. */
function errorType(text: string): string | undefined {
	try {
		const parsed = errorSchema.safeParse(JSON.parse(text))
		return parsed.success ? parsed.data.error.type : undefined
	} catch {
		return undefined
	}
}

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
 * The variables `boot` requires of `app` that a generated case never uses: each challenge's secret and site key, since
 * no case solves a challenge, and each SPA mount's `public` variables, since no case reads a page's config. The kit's
 * challenge stand-in refuses every token, so no verification leaves the process.
 */
function unusedVariables(app: ContractImplementation<AnyContract>): ApplicationEnvironment {
	const artifact = compileContract(app.contract, app.database?.tables ?? {})
	const challengeVariables = (challenge: ProcedureChallenge): readonly string[] =>
		challenge.provider === 'altcha' || challenge.siteKey === undefined ? [challenge.secret] : [challenge.secret, challenge.siteKey]
	const names = Object.values(artifact.mounts).flatMap((mount): readonly string[] => mount.kind === 'spa' ? (mount.public ?? []) : [])
	const procedures = Object.values(artifact.procedures ?? {}).flatMap((procedure) =>
		procedure.challenge === null ? [] : challengeVariables(procedure.challenge)
	)
	// Long enough for an ALTCHA key, which boot refuses under 32 characters.
	return Object.fromEntries([...names, ...procedures].map((name) => [name, 'unused-by-every-generated-case-of-the-kit']))
}

/**
 * The least a member manager holds in `scope` for IAM to let it give or remove the roles a case may ask for: the
 * endpoint's action, one assigning role of each (`assignableBy`) that adds the fewest actions beyond those, and the
 * actions of each as plain grants. The roles a case asks for are the membership roles its input names; an input that
 * names none may ask for any, so the caller then covers every membership role of the dimension. Where one role assigns
 * them all, it is the only role held. Every role is held in `scope`, an application-wide assigner too: IAM counts any
 * assigning role held there, and a grant in `scope` reaches no other value.
 */
export const managerGrants = (
	artifact: Pick<ContractArtifact, 'roles'>,
	action: string,
	input: Readonly<Record<string, unknown>>,
	scope: Scope,
): Grant[] => {
	const roles = artifact.roles
	const members = Object.keys(roles).sort().filter((role) => roles[role]?.member?.scope === scope.type)
	const named = members.filter((role) => Object.values(input).includes(role))
	const targets = named.length > 0 ? named : members
	const assignersOf = (role: string): readonly string[] => roles[role]?.member?.assignableBy ?? []
	const actions = [action, ...targets.flatMap((target) => roles[target]?.grants ?? [])]
	// An assigner's cost is what it grants beyond the actions the caller holds anyway; a tie goes to the first name.
	const extra = (role: string): number => (roles[role]?.grants ?? []).filter((granted) => !actions.includes(granted)).length
	const narrowest = (candidates: readonly string[]): string | undefined =>
		[...candidates].sort((left, right) => extra(left) - extra(right) || (left < right ? -1 : left > right ? 1 : 0))[0]
	const common = narrowest(Object.keys(roles).sort().filter((role) => targets.every((target) => assignersOf(target).includes(role))))
	const assigners = common === undefined ? targets.flatMap((target) => narrowest(assignersOf(target)) ?? []) : [common]
	return [
		...[...new Set(actions)].map((held) => ({ action: held, scope })),
		...[...new Set(assigners)].map((role) => ({ role, scope })),
	]
}

/**
 * The endpoint access kit of `app`, whose data layer is `scoped(tables)`, over `postgres`. It boots `app` once, so the
 * application's layer is bound here and nowhere else in the process.
 */
export function endpointAccessKit<DB, P>(
	app: ContractImplementation<AnyContract>,
	tables: Tables<DB, P>,
	postgres: TestDatabase,
	options: EndpointAccessOptions = {},
): EndpointAccessKit {
	// The objects of the files the cases seed live in memory; their rows are the application's own tables.
	const objects = new MemoryFileObjects()
	const { kit, standIn } = standInIamKit(app, {
		database: postgres.database,
		files: objects,
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
			links: linksOf(row.id, requirement.action, requirement.access),
		}
	}

	/** The link mounts an endpoint's `Ref` issues for: its dimension's whose `issuedBy` is its action. */
	const linksOf = (id: string, action: string, access: AccessForm): ActionEndpoint['links'] => {
		if (access.form !== 'on' && access.form !== 'in') return []
		const issues = kit.artifact.declared?.[id]?.issues
		return Object.entries(kit.artifact.mounts).flatMap(([name, mount]) =>
			mount.kind === 'link' && mount.dimension === access.dimension && mount.issuedBy === action && (issues === undefined || issues === name)
				? [{ mount: name, grants: mount.grants }]
				: []
		)
	}

	/** An endpoint of several capabilities, as one `ActionEndpoint` per capability, by its name. */
	const capabilitiesEndpointOf = (id: string): ReadonlyMap<string, ActionEndpoint> => {
		const row = kit.artifact.endpoints.find((candidate) => candidate.id === id)
		const requirement = row?.requirement
		if (row === undefined || requirement?.kind !== 'capabilities') {
			throw new Error(`${id} is not an endpoint of the contract with several capabilities`)
		}
		return new Map(
			Object.entries(requirement.capabilities).map(([name, capability]) => [name, {
				id: row.id,
				link: null,
				method: row.method,
				path: row.path,
				callers: row.callers,
				action: capability.action,
				access: capability.access,
				input: row.input,
				directory: null,
				manages: null,
				links: [],
			}]),
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

	/**
	 * A case's request by a new caller holding `grants`, its generated fields filled for `chain` and that caller. Only an
	 * own case passes `refusals: 'declared'`.
	 */
	const ask = async (
		row: ActionEndpoint,
		grants: readonly Grant[],
		input: Readonly<Record<string, unknown>>,
		chain: Chain,
		refusals: Refusals = 'none',
	): Promise<{ readonly status: number; readonly text: string; readonly marks: readonly string[] }> => {
		const asker = callerFor(row, grants)
		const asked = withGenerated(row, input, chain, asker.caller)
		return { ...(await askAs(row, asker.fetch, asked.input, refusals)), marks: asked.marks }
	}

	// A seeded file column references an empty object, which a handler that serves or opens the file reads here.
	let stocked = 0
	const stockSeededObjects = (): void => {
		const seeded = postgres.seededObjects()
		for (const key of seeded.slice(stocked)) {
			objects.objects.set(key, { bytes: new Uint8Array(0), contentType: 'application/octet-stream', version: SEEDED_OBJECT_VERSION })
		}
		stocked = seeded.length
	}

	/** The request of a case: a GET's input in its URL, a file field's marker as a file of its kind in a multipart body. */
	const requestOf = async (row: ActionEndpoint, body: Readonly<Record<string, unknown>>): Promise<readonly [string, RequestInit]> => {
		if (row.method === 'GET') {
			const params = new URLSearchParams(Object.entries(body).map(([name, value]) => [name, value === null ? 'null' : String(value)]))
			return [params.size === 0 ? row.path : `${row.path}?${params}`, { method: 'GET' }]
		}
		const fields = fileFields(row.input)
		if (fields.size === 0) {
			return [row.path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }]
		}
		const json: Record<string, unknown> = {}
		const files: [string, File][] = []
		for (const [name, value] of Object.entries(body)) {
			if (!fields.has(name)) {
				json[name] = value
				continue
			}
			for (const item of Array.isArray(value) ? value : [value]) {
				const kind = fileKindOf(item)
				if (kind === undefined) throw new Error(`${row.id}: the file field ${name} holds ${JSON.stringify(item)}, not a generated file`)
				files.push([name, await generatedFile(row.id, name, kind)])
			}
		}
		const form = new FormData()
		form.append(FILE_INPUT_PART, JSON.stringify(json))
		for (const [name, file] of files) form.append(name, file)
		return [row.path, { method: 'POST', body: form }]
	}

	/** The file a case sends in `field`: the author's file fixture of the endpoint's field, else a sample of `kind`. */
	const generatedFile = async (endpoint: string, field: string, kind: string): Promise<File> => {
		const types = kit.artifact.fileKinds?.[kind]?.types ?? []
		const fixture = options.files?.[endpoint]?.[field]
		if (fixture === undefined) {
			const sample = sampleFile(kind, types)
			return new File([sample.bytes], `generated-${kind}`, { type: sample.type })
		}
		const path = fileURLToPath(fixture)
		const bytes = await fixtureBytes(endpoint, field, path)
		const type = types.find((candidate) => bytesAreOfType(candidate, bytes.subarray(0, SNIFF_BYTES)))
		if (type === undefined) {
			throw new Error(`${endpoint}: the file of ${field}, ${path}, is none of the types of files.${kind} (${types.join(', ')})`)
		}
		return new File([bytes], basename(path), { type })
	}

	// A file fixture is read once; every case sends the same bytes.
	const fixtureFiles = new Map<string, Uint8Array<ArrayBuffer>>()
	const fixtureBytes = async (endpoint: string, field: string, path: string): Promise<Uint8Array<ArrayBuffer>> => {
		const known = fixtureFiles.get(path)
		if (known !== undefined) return known
		let bytes: Uint8Array<ArrayBuffer>
		try {
			bytes = new Uint8Array(await readFile(path))
		} catch {
			throw new Error(`${endpoint}: the file of ${field} in the fixtures, ${path}, cannot be read; add it to the repository or correct its path`)
		}
		fixtureFiles.set(path, bytes)
		return bytes
	}

	const askAs = async (
		row: ActionEndpoint,
		fetch: RpcFetch,
		body: Readonly<Record<string, unknown>>,
		refusals: Refusals = 'none',
	): Promise<{ readonly status: number; readonly text: string }> => {
		stockSeededObjects()
		const [url, init] = await requestOf(row, body)
		const response = await fetch(url, init)
		const text = await response.text()
		// A 400 hides what the case is about: input is parsed before the access form runs, and a handler's refusal of
		// the input it was given is no answer to another scope. Either is what the generator could not build.
		if (response.status === 400) {
			const type = errorType(text)
			const declared = type !== undefined && type !== 'validation' && options.refusals?.[row.id]?.includes(type) === true
			// Only the own case may take it: it shows the access form let the caller through. A leak or a global case that
			// got it would pass on an answer that holds nothing, which proves nothing.
			if (declared && refusals === 'declared') {
				return { status: response.status, text }
			}
			if (declared) {
				throw new Error(
					`${row.id}: the handler answered its declared refusal (400 ${type}), which only the own case takes; this case proves nothing on it until the fixtures give what the handler needs (${text})`,
				)
			}
			throw new Error(
				type === 'validation'
					? `${row.id}: the case's input does not match the endpoint's input schema; correct its fixture (${text})`
					: `${row.id}: the handler refused the case's input (400 ${
						type ?? 'without a type'
					}); the case cannot reach what it tests until its fixtures give what the handler needs: a picked person in members, a row of its object in rows, the state in seeds, a file it accepts in files, the whole input in fixtures, or the refusal it answers in refusals (${text})`,
			)
		}
		return { status: response.status, text }
	}

	/**
	 * Two scopes of `dimension`: rows of the table that owns it when one does, with `seed`, otherwise two fresh scope
	 * values. Each row `input` names in the object (`rows`) is seeded in each scope's row.
	 */
	const scopesOf = async (
		action: string,
		dimension: string,
		field: SchemaShape | undefined,
		seed: Seed,
		input: Readonly<Record<string, unknown>>,
	): Promise<Scopes> => {
		const named = rowFields(input)
		const owner = ownerOf(dimension)
		if (named.length > 0 && owner === undefined) {
			throw new Error(`no table owns ${dimension}, so the kit seeds no ${named.map((row) => row.table).join(', ')} row in one`)
		}
		if (owner === undefined) {
			const own = freshValue(dimension, 'own', field)
			const other = freshValue(dimension, 'other', field)
			return {
				own: { target: own, grants: [{ action, scope: { type: dimension, value: own } }], chain: [{ type: dimension, value: own }], rows: {} },
				other: {
					target: other,
					grants: [{ action, scope: { type: dimension, value: other } }],
					values: [other],
					chain: [{ type: dimension, value: other }],
					rows: {},
				},
			}
		}
		const worlds = await postgres.seedWorlds(tables, owner, seed)
		const own = await rowsIn(worlds.own, named)
		const other = await rowsIn(worlds.other, named)
		return {
			own: {
				target: worlds.own.key,
				grants: [{ action, scope: { type: worlds.dimension, value: worlds.own.scope } }],
				chain: worlds.own.chain,
				rows: own.rows,
			},
			other: {
				target: worlds.other.key,
				grants: [{ action, scope: { type: worlds.dimension, value: worlds.other.scope } }],
				values: [...worldValues(worlds, 'other'), ...other.values],
				chain: worlds.other.chain,
				rows: other.rows,
			},
		}
	}

	/** One row of each named table seeded in `object`: its key by input field, and every key and marker it holds. */
	const rowsIn = async (object: WorldRow, named: ReturnType<typeof rowFields>) => {
		const rows: Record<string, string> = {}
		const values: string[] = []
		for (const { field, table } of named) {
			const seeded = await postgres.seedUnder(tables, table, object)
			rows[field] = seeded.key
			values.push(seeded.key, ...seeded.markers)
		}
		return { rows, values }
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
			return scopesOf(action, dimension, undefined, {}, {})
		}
		return { own: { target: '', grants: own, chain: [], rows: {} }, other: { target: '', grants: other, values, chain: [], rows: {} } }
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
			const scopes = await scopesOf(action, dimension, field, seed, {})
			return { own: [scopes.own], other: [scopes.other], values: scopes.other.values }
		}
		return { own, other, values }
	}

	/** `input` addressing `side`: its target in the `from` field, and its own key in each field that names a row (`rows`). */
	const addressing = (
		input: Readonly<Record<string, unknown>>,
		from: string | null,
		side: { readonly target: string; readonly rows?: Readonly<Record<string, string>> },
	): Readonly<Record<string, unknown>> => ({ ...input, ...side.rows, ...(from === null ? {} : { [from]: side.target }) })

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
	 * `input` with every field that holds `GENERATED_INVITATION` set to an invitation the stand-in IAM holds open in the
	 * managed value of `chain`, to a membership role the input names (else the dimension's first): what a cancel cancels.
	 */
	const withInvitation = (row: ActionEndpoint, input: Readonly<Record<string, unknown>>, chain: Chain): Addressed => {
		const fields = Object.keys(input).filter((field) => input[field] === GENERATED_INVITATION)
		if (fields.length === 0) return { input, marks: [] }
		const dimension = row.manages
		if (dimension === null) {
			throw new Error(`${row.id} manages no members, so no input field of it names an invitation (${fields.join(', ')})`)
		}
		const value = chain.find((link) => link.type === dimension)?.value
		const roles = Object.keys(kit.artifact.roles).sort().filter((name) => kit.artifact.roles[name]?.member?.scope === dimension)
		const role = roles.find((name) => Object.values(input).includes(name)) ?? roles[0]
		if (value === undefined || role === undefined) {
			throw new Error(`${row.id}: the kit locates no ${dimension} with a membership role to hold an invitation in`)
		}
		const id = standIn.seedInvitation({ type: dimension, value }, role, `invited-${randomHex()}@example.test`)
		return { input: { ...input, ...Object.fromEntries(fields.map((field) => [field, id])) }, marks: [id] }
	}

	/**
	 * `input` with every field that holds `GENERATED_LINK` set to a share link of the endpoint's mount, bound to `chain`
	 * and issued by `issuer`, the case's caller: what a revoke revokes.
	 */
	const withLink = (row: ActionEndpoint, input: Readonly<Record<string, unknown>>, chain: Chain, issuer: TestCaller): Addressed => {
		const fields = Object.keys(input).filter((field) => input[field] === GENERATED_LINK)
		if (fields.length === 0) return { input, marks: [] }
		const [link] = row.links
		if (link === undefined || chain.length === 0) {
			throw new Error(`${row.id} issues no share link of its object, so no input field of it names one (${fields.join(', ')})`)
		}
		const id = standIn.seedLink(issuer.id, link.mount, chain)
		return { input: { ...input, ...Object.fromEntries(fields.map((field) => [field, id])) }, marks: [id] }
	}

	/** `input` with every generated field filled: a member, an invitation and a link of `chain`, for the case's `caller`. */
	const withGenerated = (row: ActionEndpoint, input: Readonly<Record<string, unknown>>, chain: Chain, caller: TestCaller): Addressed => {
		const member = withMember(row, input, chain)
		const invitation = withInvitation(row, member.input, chain)
		const link = withLink(row, invitation.input, chain, caller)
		return { input: link.input, marks: [...member.marks, ...invitation.marks, ...link.marks] }
	}

	/**
	 * The grants a case's caller holds: its side's, or, on an endpoint that reads a member directory, the action on the
	 * directory's value, where IAM checks a lookup and a list: a caller who may read it, still only in its own scope. On
	 * an endpoint that manages members it is the action on the target's own value with the least IAM requires there to
	 * assign or revoke a role (`managerGrants`). An endpoint that issues links adds the actions its mounts grant, which
	 * IAM requires of the issuer.
	 */
	const holding = (row: ActionEndpoint, input: Readonly<Record<string, unknown>>, grants: readonly Grant[], chain: Chain): readonly Grant[] => {
		const { directory, manages } = row
		const at = (dimension: string) => chain.find((link) => link.type === dimension)?.value
		const managed = manages === null ? undefined : at(manages)
		const listed = directory === null ? undefined : at(directory.dimension)
		let held = grants
		if (manages !== null && managed !== undefined) {
			held = managerGrants(kit.artifact, row.action, input, { type: manages, value: managed })
		} else if (directory !== null && listed !== undefined) {
			held = [{ action: row.action, scope: { type: directory.dimension, value: listed } }]
		}
		const scopes = held.flatMap((grant) => ('action' in grant ? [grant.scope] : []))
		return [...held, ...row.links.flatMap((link) => link.grants.flatMap((action) => scopes.map((scope) => ({ action, scope }))))]
	}

	/** The outcome of the own scope's answers: answered unless one is a failure or an authorization refusal. */
	const leakOutcome = (answers: readonly { readonly status: number; readonly text: string }[], values: readonly string[]): LeakOutcome => {
		const leaked = values.filter((value) => answers.some((answer) => answer.text.includes(value)))
		const refused = answers.find((answer) => answer.status >= 500 || answer.status === 401 || answer.status === 403 || answer.status === 404)
		return refused === undefined ? { answered: true, leaked } : { answered: false, status: refused.status, leaked }
	}

	/** A link holder of `row`'s mount, its key bound to the own world's object, and the rows `input` names in that object. */
	const linkHolder = async (
		row: ActionEndpoint,
		mount: string,
		seed: Seed,
		input: Readonly<Record<string, unknown>>,
	): Promise<{ readonly fetch: RpcFetch; readonly rows: Readonly<Record<string, string>> }> => {
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
		const fetch: RpcFetch = (request, init) => {
			const headers = new Headers(init?.headers)
			headers.set('Authorization', `Bearer ${holder.key ?? ''}`)
			return kit.fetch(request, { ...init, headers })
		}
		return { fetch, rows: (await rowsIn(own, rowFields(input))).rows }
	}

	// The cases of one call: `removals` takes the removal of the application rows it seeds, which `drained` runs once
	// the call and the runs it kicked are over. A list per call, so a concurrent case never removes the rows another
	// was given; the generated cases run one after another, since a row a required foreign key needed is shared.
	const accessKitOf = (removals: (() => Promise<void>)[]): EndpointAccessKit => {
		/** One row of each application table `appRows` names, for this call only. */
		const seedAppRows = async (appRows: AppRows): Promise<void> => {
			if (Object.keys(appRows).length === 0) return
			removals.push((await postgres.seedApplicationRows(tables, appRows)).remove)
		}

		return {
			async denied(endpoint, input, seed = {}) {
				const row = endpointOf(endpoint)
				const { action, access } = row
				if (access.form !== 'on' && access.form !== 'in') {
					throw new Error(`${endpoint} has the access form ${access.form}; only on and in name an object or a scope value`)
				}
				const scopes = await scopesOf(action, access.dimension, fieldOf(row.input, access.from), seed, input)
				const asked = addressing(input, access.from, scopes.other)
				const { status } = await ask(row, holding(row, input, scopes.own.grants, scopes.own.chain), asked, scopes.own.chain)
				return { status }
			},
			async leaked(endpoint, input, seed = {}, appRows = {}) {
				const row = endpointOf(endpoint)
				const { action, access } = row
				if (access.form === 'in') {
					await seedAppRows(appRows)
					const scopes = await inScopesOf(action, access.dimension, fieldOf(row.input, access.from), seed)
					const grants = (targets: readonly InTarget[]): Grant[] =>
						targets.flatMap(({ target, chain }) => holding(row, input, [{ action, scope: { type: access.dimension, value: target } }], chain))
					const marks: string[] = []
					for (const side of scopes.other) {
						const answer = await ask(row, grants(scopes.other), addressing(input, access.from, side), side.chain)
						marks.push(...answer.marks)
					}
					const answers = []
					for (const side of scopes.own) {
						answers.push(await ask(row, grants(scopes.own), addressing(input, access.from, side), side.chain))
					}
					return leakOutcome(answers, [...scopes.values, ...marks])
				}
				if (access.form !== 'on' && access.form !== 'over') {
					throw new Error(`${endpoint} has the access form ${access.form}; only on, in and over answer with rows of a scope`)
				}
				await seedAppRows(appRows)
				const scopes = access.form === 'on'
					? await scopesOf(action, access.dimension, fieldOf(row.input, access.from), seed, input)
					: await listScopesOf(action, access.dimension)
				const from = access.form === 'on' ? access.from : null
				const other = await ask(
					row,
					holding(row, input, scopes.other.grants, scopes.other.chain),
					addressing(input, from, scopes.other),
					scopes.other.chain,
				)
				const answer = await ask(
					row,
					holding(row, input, scopes.own.grants, scopes.own.chain),
					addressing(input, from, scopes.own),
					scopes.own.chain,
				)
				return leakOutcome([answer], [...scopes.other.values, ...other.marks])
			},
			async own(endpoint, input, seed = {}, appRows = {}) {
				const row = endpointOf(endpoint)
				const { action, access } = row
				if (access.form !== 'on') {
					throw new Error(`${endpoint} has the access form ${access.form}; only on addresses an object of its own`)
				}
				await seedAppRows(appRows)
				if (row.link !== null) {
					const holder = await linkHolder(row, row.link, seed, input)
					const { status } = await askAs(row, holder.fetch, { ...input, ...holder.rows }, 'declared')
					return { status }
				}
				const scopes = await scopesOf(action, access.dimension, fieldOf(row.input, access.from), seed, input)
				const { status } = await ask(
					row,
					holding(row, input, scopes.own.grants, scopes.own.chain),
					addressing(input, access.from, scopes.own),
					scopes.own.chain,
					'declared',
				)
				return { status }
			},
			async scoped(endpoint, input) {
				const row = globalEndpointOf(endpoint)
				const dimension = row.access.form === 'creates' ? row.access.dimension : scopeTypeOf(kit.artifact.dimensions)
				const { status } = await ask(row, [{ action: row.action, scope: { type: dimension, value: freshValue(dimension, 'own', undefined) } }], input, [])
				return { status }
			},
			async anyone(endpoint, input) {
				const row = kit.artifact.endpoints.find((candidate) => candidate.id === endpoint)
				if (row?.kind !== 'public') {
					throw new Error(`${endpoint} is not a public procedure of the contract`)
				}
				const response = await kit.fetch(row.path, {
					method: row.method,
					headers: { 'Content-Type': 'application/json', Origin: kit.origin, 'Sec-Fetch-Site': 'same-origin' },
					body: JSON.stringify(input),
				})
				const status = response.status
				const challenged = status === 400 && errorType(await response.text()) === 'challenge_failed'
				return status >= 500 || status === 401 || status === 403 || challenged ? { answered: false, status } : { answered: true }
			},
			async global(endpoint, input) {
				const row = globalEndpointOf(endpoint)
				const { status } = await askAs(row, callerFor(row, [], [{ action: row.action }]).fetch, input)
				// Neither form refuses with 404, so a 404 is the handler's own answer (a row the sampled input names is missing).
				return status >= 500 || status === 401 || status === 403 ? { answered: false, status } : { answered: true }
			},
			async capability(endpoint, capability, input, seed = {}) {
				const capabilities = capabilitiesEndpointOf(endpoint)
				const named = capabilities.get(capability)
				if (named === undefined) {
					throw new Error(`${endpoint} has no capability '${capability}' (capabilities: ${[...capabilities.keys()].join(', ')})`)
				}
				const grants: Grant[] = []
				const global: { readonly action: string }[] = []
				let asked = input
				for (const [name, other] of capabilities) {
					if (name === capability) continue
					if (other.access.form === 'over') {
						global.push({ action: other.action })
					} else if (other.access.form === 'on' || other.access.form === 'in') {
						const { own } = await scopesOf(other.action, other.access.dimension, fieldOf(other.input, other.access.from), {}, input)
						asked = addressing(asked, other.access.from, own)
						grants.push(...own.grants)
					}
				}
				const { access } = named
				if (access.form === 'on' || access.form === 'in') {
					const scopes = await scopesOf(named.action, access.dimension, fieldOf(named.input, access.from), seed, input)
					asked = addressing(asked, access.from, scopes.other)
					grants.push(...scopes.own.grants)
				}
				const { status } = await askAs(named, callerFor(named, grants, global).fetch, asked)
				return { status }
			},
		}
	}
	// Each case waits for the runs its requests kicked, so the suite's teardown never closes the database under one, and
	// only then removes its application rows, which those runs may still read. Every step runs whatever failed before
	// it, and the case's own error is thrown first.
	const drained =
		<A extends readonly unknown[], R>(method: (kit: EndpointAccessKit) => (...args: A) => Promise<R>) => async (...args: A): Promise<R> => {
			const removals: (() => Promise<void>)[] = []
			let outcome: { readonly ok: true; readonly value: R } | { readonly ok: false; readonly error: unknown }
			try {
				outcome = { ok: true, value: await method(accessKitOf(removals))(...args) }
			} catch (error) {
				outcome = { ok: false, error }
			}
			const failures: unknown[] = []
			for (const step of [() => kit.drain(), ...removals]) {
				try {
					await step()
				} catch (error) {
					failures.push(error)
				}
			}
			if (!outcome.ok) {
				if (failures.length === 0) throw outcome.error
				throw new AggregateError([outcome.error, ...failures], 'the case failed, and so did its cleanup')
			}
			if (failures.length === 1) throw failures[0]
			if (failures.length > 1) throw new AggregateError(failures, 'the cleanup of the case failed')
			return outcome.value
		}
	return Object.freeze({
		denied: drained((cases) => cases.denied),
		leaked: drained((cases) => cases.leaked),
		own: drained((cases) => cases.own),
		scoped: drained((cases) => cases.scoped),
		global: drained((cases) => cases.global),
		anyone: drained((cases) => cases.anyone),
		capability: drained((cases) => cases.capability),
	})
}
