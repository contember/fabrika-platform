// What `compileContract` refuses that the types let through, and what `buildArtifact` refuses in a declaration a
// reader of source could produce. Every refusal names where it is and the allowed form.

import { canonicalArtifactJson, type SchemaShape, type TablePolicyArtifact } from '@fabrika/auth-core'
import { appSchemaSchema } from '@fabrika/auth'
import { MAX_CSP_ORIGINS } from '@fabrika/proxy-core/headers'
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
	parseContractArtifact,
	schemaFromContract,
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
			csp: {
				connectSrc: [{ origin: 'https://maps.example.com/tiles', purpose: 'Map tiles' }],
				frameAncestors: [{ origin: 'https://*.example.com', purpose: 'Any portal' }],
			},
		}))
		expect(compileProblems(contract)).toEqual([
			"files 'attachments': 'image/*' is not an exact media type (allowed: 'image/png'; no wildcards or parameters)",
			"files 'attachments': its owner 'tasks' is not a table with a dimension scope in src/db/tables.ts",
			"job 'nightly': schedule '@daily' is not five cron fields separated by single spaces (allowed: '0 3 * * *')",
			"job 'nightly': timeout 'ten minutes' is not a duration (allowed: '30s', '10m', '1h')",
			"import 'catalog': usedBy 'api.missing' is not a procedure of this contract (allowed: an id such as 'api.products.show')",
			"csp connectSrc: 'https://maps.example.com/tiles' is not an https origin (allowed: 'https://maps.example.com', no path or wildcard)",
			"csp frameAncestors: 'https://*.example.com' is not an https origin (allowed: 'https://maps.example.com', no path or wildcard)",
		])
	})

	test('at most 16 origins per CSP directive, the bound the proxy manifest also holds', () => {
		const origins = (count: number) => Array.from({ length: count }, (_, index) => ({ origin: `https://tiles${index}.example`, purpose: 'Map tiles' }))
		const withImgSrc = (count: number) => defineContract(vocabulary, () => ({ csp: { imgSrc: origins(count) } }))
		expect(compileContract(withImgSrc(MAX_CSP_ORIGINS), {}).csp.imgSrc).toHaveLength(16)
		expect(compileProblems(withImgSrc(MAX_CSP_ORIGINS + 1))).toEqual(['csp imgSrc: 17 origins exceed the limit of 16'])
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

	test('an option that names a field the builder sets is refused, and never replaces it', () => {
		const webhookOptions = { scheme: 'github-sha256', boundTo: 'app', actions: ['tasks.write'], input: Id } as const
		Object.defineProperty(webhookOptions, 'kind', { value: 'form', enumerable: true })
		Object.defineProperty(webhookOptions, 'path', { value: '/contact', enumerable: true })
		const cronOptions = { actions: ['tasks.write'], scope: 'app' } as const
		Object.defineProperty(cronOptions, 'schedule', { value: '* * * * *', enumerable: true })
		Object.defineProperty(cronOptions, 'retry', { value: 3, enumerable: true })
		const contract = defineContract(vocabulary, (c) => ({
			hook: c.webhook('/hooks/github', webhookOptions),
			jobs: { nightly: c.cron('0 3 * * *', cronOptions) },
		}))
		const hook = contract.surface.hook
		expect([hook.kind, hook.path, hook.unknownOptions]).toEqual(['webhook', '/hooks/github', ['kind', 'path']])
		expect(contract.surface.jobs.nightly.schedule).toBe('0 3 * * *')
		expect(compileProblems(contract)).toEqual([
			"mount 'hook': 'kind' is set by c.webhook itself and cannot be an option; remove it",
			"mount 'hook': 'path' is set by c.webhook itself and cannot be an option; remove it",
			"job 'nightly': 'schedule' is set by c.cron itself and cannot be an option; remove it",
			"job 'nightly': 'retry' is not an option of c.cron (allowed: actions, scope, timeout, retries)",
		])
	})

	test('a string literal or an enum is a scope coordinate', () => {
		const contract = defineContract(vocabulary, (c) => ({
			api: c.rpc('/api', { callers: ['human'] }, {
				byLiteral: c.query({ input: z.strictObject({ id: z.literal('alpha') }), output: Id, access: { action: 'tasks.read', on: 'task', from: 'id' } }),
				byEnum: c.query({
					input: z.strictObject({ id: z.enum(['alpha', 'beta']) }),
					output: Id,
					access: { action: 'tasks.read', in: 'workspace', from: 'id' },
				}),
			}),
		}))
		expect(compileContract(contract, {}).endpoints.map((row) => row.id)).toEqual(['api.byEnum', 'api.byLiteral'])
	})

	test('a constraint the artifact parser would refuse is refused when compiling', () => {
		const contract = defineContract(vocabulary, (c) => ({
			api: c.rpc('/api', { callers: ['human'] }, {
				short: c.query({ output: z.strictObject({ id: z.string().max(-1) }), access: { member: true } }),
				stepless: c.query({ output: z.strictObject({ n: z.number().multipleOf(0) }), access: { member: true } }),
			}),
		}))
		expect(compileProblems(contract)).toEqual([
			"mount 'api' procedure 'short' output.id: the length -1 is not a whole number of at least 0",
			"mount 'api' procedure 'stepless' output.n: .multipleOf(0) is not a positive step",
		])
	})

	test('the compiled artifact is parsed before it is returned', () => {
		const reference: TablePolicyArtifact = {
			scope: { mode: 'reference', reason: '' },
			actions: { read: 'tasks.read', insert: null, update: null, delete: null },
			insert: [],
			update: [],
			version: null,
			createdBy: null,
			columns: {},
		}
		const contract = defineContract(vocabulary, (c) => ({ health: c.health('/healthz') }))
		expect(compileProblems(contract, { countries: reference })).toEqual([
			'artifact tables.countries.scope.reason: Too small: expected string to have >=1 characters',
		])
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
			`procedure 'api.mixed': access {"member":true,"action":"notes.read","over":"workspace"} is not one access form (allowed: { member: true }, { action, over }, { action, in, from }, { action, on, from }, { action, creates }, { action, app: true })`,
			"procedure 'api.typo': 'notes.raed' is not an action of the contract — did you mean 'notes.read'?",
			"procedure 'api.optional': access.from 'id' is not a required string field of the input (allowed: a string, a string literal or an enum)",
			"procedure 'api.create': creates a 'workspace' in a query (allowed: c.mutation)",
		])
	})

	test('an app form beside a dimension, on an RPC procedure and on an export procedure', () => {
		const products = base.exports['products']
		if (products === undefined) {
			throw new Error('the notes fixture changed')
		}
		// A const, not a literal: the types refuse the literal, and a reader of source could still produce this value.
		const both = { action: 'notes.read', app: true, over: 'workspace' } as const
		const problems = build({
			...withMounts({
				...base.mounts,
				api: { ...api, procedures: { both: { '~kind': 'procedure', type: 'query', input: null, output, access: both } } },
			}),
			exports: {
				...base.exports,
				products: { ...products, procedures: { list: { '~kind': 'procedure', type: 'query', input: null, output, access: both } } },
			},
		})
		expect(problems.filter((problem) => problem.startsWith('procedure'))).toEqual([
			expect.stringContaining(`procedure 'api.both': access {"action":"notes.read","app":true,"over":"workspace"} is not one access form`),
			"procedure 'products.v1.list': an export procedure reads in one dimension (allowed: { action, over }, { action, in, from }, { action, on, from })",
			expect.stringContaining(`procedure 'products.v1.list': access {"action":"notes.read","app":true,"over":"workspace"} is not one access form`),
		])
	})

	test('a wildcard grant or action, and a link procedure outside the link grants', () => {
		const problems = build({
			...withMounts({
				...base.mounts,
				shared: { ...shared, procedures: { note: { '~kind': 'procedure', type: 'query', input: null, output, access: { action: 'notes.write' } } } },
			}),
			actions: { ...base.actions, 'notes.*': 'Everything' },
			roles: { ...base.roles, everything: { grants: ['*'] } },
		})
		expect(problems).toEqual([
			"action 'notes.*': an action is exact, dot-separated words (allowed: 'notes.read'; no '*')",
			"role 'everything': '*' is not an action of the contract",
			"procedure 'shared.note': needs 'notes.write', which the link does not grant (grants: notes.read)",
		])
	})

	test('a locale IAM does not speak, and a display name that is not one short line', () => {
		expect(build({ ...base, locale: 'de', displayName: ' Notes\n' })).toEqual([
			"locale: 'de' is not a language IAM speaks (allowed: 'en', 'cs')",
			'displayName: is empty or starts or ends with whitespace',
		])
		expect(build({ ...base, displayName: 'N'.repeat(81) })).toEqual(['displayName: is longer than 80 characters'])
		expect(build({ ...base, displayName: 'Notes\u0007' })).toEqual(['displayName: contains a control character'])
	})

	test("a directory other than 'labels', or one on a dimension that declares no members", () => {
		const problems = build({
			...base,
			dimensions: {
				...base.dimensions,
				note: { in: 'workspace', directory: 'labels' },
				workspace: { ...base.dimensions['workspace'], directory: 'names' },
			},
		})
		expect(problems).toEqual([
			"dimension 'workspace': its directory is 'names' (allowed: 'labels')",
			"dimension 'note': declares a directory and no members: { manage, list } whose list it labels",
		])
	})

	test('external on a role that is not a membership role, or a value other than true', () => {
		const problems = build({
			...base,
			roles: {
				...base.roles,
				support: { grants: ['contacts.read'], external: true },
				editor: { grants: ['notes.read'], member: { scope: 'workspace', assignableBy: ['owner'] }, external: false },
			},
		})
		expect(problems).toEqual([
			"role 'support': is declared external and is not a membership role: only a role with member: { scope, … } may admit externals",
			"role 'editor': its external is false (allowed: external: true, or no external)",
		])
	})

	test('an external membership role reaches the artifact; a role without it keeps the shape it had, so digests stay', () => {
		const artifact = buildArtifact(
			{
				...base,
				roles: { ...base.roles, partner: { grants: ['notes.read'], member: { scope: 'workspace', assignableBy: ['owner'] }, external: true } },
			},
			notesArtifact.tables,
		)
		expect(artifact.roles['partner']).toEqual({ grants: ['notes.read'], member: { scope: 'workspace', assignableBy: ['owner'] }, external: true })
		expect(Object.keys(artifact.roles['editor'] ?? {}).sort()).toEqual(['grants', 'member'])
		expect(canonicalArtifactJson(buildArtifact(base, notesArtifact.tables))).not.toContain('"external"')
	})

	test('the artifact boundary refuses external on a role that is not a membership role; translation carries the flag', () => {
		const member = { grants: ['notes.read'], member: { scope: 'workspace', assignableBy: ['owner'] }, external: true }
		const parsed = parseContractArtifact({ ...notesArtifact, roles: { ...notesArtifact.roles, partner: member } })
		expect(schemaFromContract(parsed).roles['partner']).toMatchObject({ member: { scope: 'workspace' }, external: true })

		const loose = { ...notesArtifact, roles: { ...notesArtifact.roles, partner: { grants: ['notes.read'], member: null, external: true } } }
		expect(() => parseContractArtifact(loose)).toThrow('only a membership role admits external principals')
		// An artifact that skipped the parser still reaches IAM with the flag, and IAM's own parser refuses it.
		const translated = schemaFromContract({ ...notesArtifact, roles: { ...notesArtifact.roles, partner: { grants: ['notes.read'], member: null, external: true } } })
		expect(translated.roles['partner']?.external).toBe(true)
		expect(appSchemaSchema.safeParse(translated).success).toBe(false)
	})

	test("a role named after one of IAM's own roles", () => {
		const problems = build({ ...base, roles: { ...base.roles, admin: { grants: ['notes.read'] } } })
		expect(problems).toEqual(["role 'admin': is a role IAM defines itself for every application (reserved: admin); choose another name"])
	})

	test('a create of a dimension that lies in another one', () => {
		const problems = build({
			...withMounts({
				...base.mounts,
				api: {
					...api,
					procedures: {
						...api.procedures,
						draft: { '~kind': 'procedure', type: 'mutation', input: null, output, access: { action: 'notes.write', creates: 'note' } },
					},
				},
			}),
			dimensions: { ...base.dimensions, note: { in: 'workspace', creator: 'author' } },
			roles: { ...base.roles, author: { grants: ['notes.read', 'notes.write'], member: { scope: 'note', assignableBy: ['author'] } } },
		})
		expect(problems).toEqual([
			"procedure 'api.draft': creates a 'note', which lies in 'workspace' (allowed: a dimension without in; a contained value is a row a store inserts)",
		])
	})

	test('an unscoped write of a reference table or a form inbox, which no site writes', () => {
		const problems = build(withMounts({
			...base.mounts,
			api: {
				...api,
				procedures: {
					...api.procedures,
					fill: {
						'~kind': 'procedure',
						type: 'mutation',
						input: null,
						output,
						access: { member: true },
						declared: { unscoped: { countries: 'write', contact_messages: 'write', notes: 'write' } },
					},
				},
			},
		}))
		expect(problems).toEqual([
			"procedure 'api.fill': declares unscoped 'countries': 'write', and no site writes a reference table: its rows come from a migration (allowed: 'read')",
			"procedure 'api.fill': declares unscoped 'contact_messages': 'write', and only its form writes a form's inbox (allowed: 'read')",
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
