// What `compileContract` refuses that the types let through, and what `buildArtifact` refuses in a declaration a
// reader of source could produce. Every refusal names where it is and the allowed form.

import type { SchemaShape, TablePolicyArtifact } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { notesArtifact } from '../../../auth-core/src/__tests__/fixtures/notes-artifact'
import {
	type AnyContract,
	buildArtifact,
	compileContract,
	type ContractDeclaration,
	ContractError,
	defineContract,
	describeContract,
	type MountDeclaration,
} from '../contract'
import { contract as notes } from './fixtures/notes-app/fabrika.contract'

const vocabulary = {
	app: 'tasks',
	dimensions: { workspace: { creator: 'owner', members: { manage: 'tasks.admin', list: 'tasks.read' } }, task: { in: 'workspace' } },
	actions: { 'tasks.read': 'Read tasks', 'tasks.write': 'Write tasks', 'tasks.admin': 'Manage the workspace' },
	roles: { owner: { grants: ['tasks.read', 'tasks.write', 'tasks.admin'], member: { scope: 'workspace', assignableBy: ['owner'] } } },
} as const

const Id = z.strictObject({ id: z.uuid() })

function problemsOf(compile: () => unknown): readonly string[] {
	try {
		compile()
	} catch (error) {
		if (error instanceof ContractError) {
			return error.problems
		}
		throw error
	}
	throw new Error('the contract compiled')
}

function compileProblems(contract: AnyContract, tables: Readonly<Record<string, TablePolicyArtifact>> = {}): readonly string[] {
	return problemsOf(() => compileContract(contract, tables))
}

describe('compileContract refuses what the types let through', () => {
	test('an input declared with z.object, which strips undeclared keys instead of refusing them', () => {
		const contract = defineContract(vocabulary, (c) => ({
			api: c.rpc('/api', { callers: ['human'] }, {
				get: c.query({ input: z.object({ id: z.uuid() }), output: Id, access: { action: 'tasks.read', on: 'task', from: 'id' } }),
			}),
		}))
		expect(compileProblems(contract)).toEqual([
			"mount 'api' procedure 'get' input: the object admits undeclared keys (allowed: z.strictObject({ … }))",
		])
	})

	test('refinements, transforms, regex flags and format options, each with its place', () => {
		const contract = defineContract(vocabulary, (c) => ({
			api: c.rpc('/api', { callers: ['human'] }, {
				refined: c.query({ output: z.strictObject({ id: z.string().refine((value) => value.length > 0) }), access: { member: true } }),
				transformed: c.query({ output: z.strictObject({ n: z.string().transform((value) => value.length) }), access: { member: true } }),
				flagged: c.query({ output: z.strictObject({ sku: z.string().regex(/^a$/i) }), access: { member: true } }),
				offset: c.query({ output: z.strictObject({ at: z.iso.datetime({ offset: true }) }), access: { member: true } }),
			}),
		}))
		expect(compileProblems(contract)).toEqual([
			"mount 'api' procedure 'refined' output.id: a 'custom' check is outside the contract subset (allowed: the supported z subset of packages/check/CLAUDE.md)",
			"mount 'api' procedure 'transformed' output.n: a 'pipe' schema is outside the contract subset (allowed: the supported z subset of packages/check/CLAUDE.md)",
			"mount 'api' procedure 'flagged' output.sku: the pattern /^a$/ has flags (allowed: a pattern without flags)",
			"mount 'api' procedure 'offset' output.at: the string format 'datetime' with these options is outside the contract subset (allowed: the supported z subset of packages/check/CLAUDE.md)",
		])
	})

	test('a path no matcher reads literally, a path the framework reserves, and two endpoints on one path', () => {
		const contract = defineContract(vocabulary, (c) => ({
			params: c.rpc('/api/:x', { callers: ['machine'] }, {}),
			internal: c.health('/__fabrika/health'),
			first: c.health('/healthz'),
			second: c.health('/healthz'),
		}))
		expect(compileProblems(contract)).toEqual([
			"mount 'params': '/api/:x' is not a literal path (allowed: '/api', segments of letters, digits and '._~-', no trailing '/')",
			"mount 'internal': '/__fabrika/health' is under /__fabrika, which the framework reserves",
			"endpoints: the endpoint table is invalid:\n- 'second' and 'first' both serve GET /healthz\n- reserved prefix '/api/:x' must be a literal path below the root, without a trailing '/'",
		])
	})

	test('jobs, CSP origins, imports and files that name nothing real', () => {
		const contract = defineContract(vocabulary, (c) => ({
			api: c.rpc('/api', { callers: ['human'] }, { list: c.query({ output: Id, access: { action: 'tasks.read', over: 'workspace' } }) }),
			files: {
				attachments: c.files({
					owner: 'tasks',
					read: 'tasks.read',
					write: 'tasks.write',
					delete: 'tasks.write',
					maxBytes: 1024,
					types: ['image/*'],
				}),
			},
			jobs: { nightly: c.cron('@daily', { actions: ['tasks.write'], scope: 'app', timeout: 'ten minutes' }) },
			imports: {
				catalog: { app: 'catalog', export: 'products', version: 1, digest: 'sha256:00', procedures: ['get'], usedBy: ['api.missing'] },
			},
			csp: { connectSrc: [{ origin: 'https://maps.example.com/tiles', purpose: 'Map tiles' }] },
		}))
		expect(compileProblems(contract)).toEqual([
			"files 'attachments': 'image/*' is not an exact media type (allowed: 'image/png'; no wildcards or parameters)",
			"files 'attachments': its owner 'tasks' is not a table with a dimension scope in src/db/tables.ts",
			"job 'nightly': schedule '@daily' is not five cron fields separated by single spaces (allowed: '0 3 * * *')",
			"job 'nightly': timeout 'ten minutes' is not a duration (allowed: '30s', '10m', '1h')",
			"import 'catalog': usedBy 'api.missing' is not a procedure of this contract (allowed: an id such as 'api.products.show')",
			"csp connectSrc: 'https://maps.example.com/tiles' is not an https origin (allowed: 'https://maps.example.com', no path or wildcard)",
		])
	})

	test('table policies that disagree with the contract', () => {
		const contract = defineContract(vocabulary, (c) => ({
			contact: c.form('/contact', { input: z.strictObject({ message: z.string() }), appendTo: 'messages' }),
		}))
		const tasks: TablePolicyArtifact = {
			scope: { mode: 'dimension', dimension: 'task', key: 'id', container: null },
			actions: { read: 'tasks.read', insert: 'tasks.write', update: null, delete: null },
			insert: [],
			update: [],
			version: null,
			createdBy: null,
			columns: {},
		}
		const messages: TablePolicyArtifact = {
			scope: { mode: 'inbox', form: 'contact' },
			actions: { read: 'tasks.read', insert: null, update: null, delete: null },
			insert: [],
			update: [],
			version: null,
			createdBy: null,
			columns: {},
		}
		expect(compileProblems(contract, { tasks, messages })).toEqual([
			"table 'tasks': lies in 'nothing', but the contract puts 'task' in 'workspace'",
			"table 'messages': its read action 'tasks.read' is granted by a membership role (allowed: an action only application-level roles grant)",
		])
		const contained: TablePolicyArtifact = {
			...tasks,
			scope: { mode: 'dimension', dimension: 'task', key: 'id', container: { dimension: 'workspace', column: 'workspace_id' } },
		}
		expect(compileProblems(contract, { tasks: contained }))
			.toEqual(["mount 'contact': appends to 'messages', which is not an inbox table of this form (scope: { inbox: 'contact', … })"])
	})

	test('applies the defaults in one place', () => {
		const contract = defineContract(vocabulary, (c) => ({
			hook: c.webhook('/hooks/github', { scheme: 'github-sha256', boundTo: 'app', actions: ['tasks.write'], input: Id }),
			jobs: { nightly: c.cron('0 3 * * *', { actions: ['tasks.write'], scope: 'workspace' }) },
		}))
		const artifact = compileContract(contract, {})
		expect(artifact.jobs['nightly']).toEqual({
			schedule: '0 3 * * *',
			actions: ['tasks.write'],
			scope: { kind: 'dimension', dimension: 'workspace' },
			timeout: null,
			retries: 0,
		})
		expect(artifact.endpoints[0]?.admission).toEqual({ contentTypes: ['application/json'], maxBytes: 1048576 })
		expect(artifact.mounts['hook']).toEqual({
			kind: 'webhook',
			path: '/hooks/github',
			scheme: 'github-sha256',
			boundTo: { kind: 'app' },
			actions: ['tasks.write'],
		})
	})
})

describe('buildArtifact refuses a declaration the types would refuse', () => {
	const base = describeContract(notes)
	const api = base.mounts['api']
	const shared = base.mounts['shared']
	if (api?.kind !== 'rpc' || shared?.kind !== 'link') {
		throw new Error('the notes fixture changed')
	}
	const output: SchemaShape = { type: 'null' }
	const withMounts = (mounts: Readonly<Record<string, MountDeclaration<SchemaShape>>>): ContractDeclaration<SchemaShape> => ({ ...base, mounts })
	const build = (contract: ContractDeclaration<SchemaShape>) => problemsOf(() => buildArtifact(contract, notesArtifact.tables))

	test('an access that mixes two forms, a typo, an optional from field, and a create in a query', () => {
		const problems = build(withMounts({
			...base.mounts,
			api: {
				...api,
				procedures: {
					mixed: { '~kind': 'procedure', type: 'query', input: null, output, access: { member: true, action: 'notes.read', over: 'workspace' } },
					typo: { '~kind': 'procedure', type: 'query', input: null, output, access: { action: 'notes.raed', over: 'workspace' } },
					optional: {
						'~kind': 'procedure',
						type: 'query',
						input: { type: 'object', fields: { id: { type: 'optional', inner: { type: 'null' } } } },
						output,
						access: { action: 'notes.read', on: 'note', from: 'id' },
					},
					create: { '~kind': 'procedure', type: 'query', input: null, output, access: { action: 'workspaces.create', creates: 'workspace' } },
				},
			},
		}))
		expect(problems.filter((problem) => problem.startsWith('procedure'))).toEqual([
			`procedure 'api.mixed': access {"member":true,"action":"notes.read","over":"workspace"} is not one access form (allowed: { member: true }, { action, over }, { action, in, from }, { action, on, from }, { action, creates })`,
			"procedure 'api.typo': 'notes.raed' is not an action of the contract — did you mean 'notes.read'?",
			"procedure 'api.optional': access.from 'id' is not a required string field of the input",
			"procedure 'api.create': creates a 'workspace' in a query (allowed: c.mutation)",
		])
	})

	test('a wildcard grant or action, and a link procedure outside the link grants', () => {
		const problems = build({
			...withMounts({
				...base.mounts,
				shared: { ...shared, procedures: { note: { '~kind': 'procedure', type: 'query', input: null, output, access: { action: 'notes.write' } } } },
			}),
			actions: { ...base.actions, 'notes.*': 'Everything' },
			roles: { ...base.roles, admin: { grants: ['*'] } },
		})
		expect(problems).toEqual([
			"action 'notes.*': an action is exact, dot-separated words (allowed: 'notes.read'; no '*')",
			"role 'admin': '*' is not an action of the contract",
			"procedure 'shared.note': needs 'notes.write', which the link does not grant (grants: notes.read)",
		])
	})

	test('a mutation in an export', () => {
		const products = base.exports['products']
		if (products === undefined) {
			throw new Error('the notes fixture changed')
		}
		const problems = build({
			...base,
			exports: {
				products: {
					...products,
					procedures: { put: { '~kind': 'procedure', type: 'mutation', input: null, output, access: { action: 'notes.read', over: 'workspace' } } },
				},
			},
		})
		expect(problems).toEqual(["procedure 'products.v1.put': an export serves queries only (allowed: c.query)"])
	})
})
